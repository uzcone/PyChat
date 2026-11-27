import asyncio
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta, timezone

import asyncpg
import websockets
from websockets.exceptions import ConnectionClosed

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8765"))
DATABASE_URL = os.getenv("DATABASE_URL", "")
SESSION_TTL_DAYS = 30
MAX_MESSAGE_CHARS = 2000
MAX_IMAGE_CHARS = 1_500_000  # ~1.1MB base64 data URL limit

# active_sockets: websocket -> {"user": str | None, "ip": str}
active_sockets: dict[websockets.WebSocketServerProtocol, dict] = {}
db_pool: asyncpg.Pool | None = None


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def normalize_username(raw: str) -> str:
    return (raw or "").strip().lower()


def is_valid_username(username: str) -> bool:
    if not (3 <= len(username) <= 20):
        return False
    return all(ch.isalnum() or ch == "_" for ch in username)


def create_password_hash(password: str, salt: str | None = None) -> tuple[str, str]:
    salt_hex = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_hex.encode("utf-8"),
        120_000,
    ).hex()
    return salt_hex, digest


def verify_password(password: str, salt_hex: str, expected_hash: str) -> bool:
    if not salt_hex or not expected_hash:
        return False
    _, actual_hash = create_password_hash(password, salt_hex)
    return hmac.compare_digest(actual_hash, expected_hash)


async def init_db() -> None:
    global db_pool
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL environment variable is not set.")

    db_pool = await asyncpg.create_pool(dsn=DATABASE_URL, min_size=1, max_size=10)
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_username TEXT NOT NULL,
                recipient_username TEXT,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_username TEXT"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_username)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC)"
        )
        user_count = await conn.fetchval("SELECT COUNT(*) FROM users")
        print(f"DB READY | existing_users={user_count}")


async def send_json(ws: websockets.WebSocketServerProtocol, payload: dict) -> None:
    try:
        await ws.send(json.dumps(payload, ensure_ascii=False))
    except ConnectionClosed:
        pass


def get_online_users() -> list[str]:
    users = sorted(
        {
            info["user"]
            for info in active_sockets.values()
            if info.get("user")
        }
    )
    return users


async def broadcast_online_users() -> None:
    users = get_online_users()
    packet = {"type": "ONLINE_USERS", "users": users}
    targets = [ws for ws, info in active_sockets.items() if info.get("user")]
    if targets:
        await asyncio.gather(*(send_json(ws, packet) for ws in targets), return_exceptions=True)


async def create_session(username: str) -> str:
    assert db_pool is not None
    token = secrets.token_urlsafe(32)
    expires_at = now_utc() + timedelta(days=SESSION_TTL_DAYS)
    async with db_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, $3)",
            token,
            username,
            expires_at,
        )
    return token


async def validate_session(token: str) -> str | None:
    assert db_pool is not None
    if not token:
        return None
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT username, expires_at
            FROM sessions
            WHERE token = $1
            """,
            token,
        )
        if not row:
            return None
        if row["expires_at"] <= now_utc():
            await conn.execute("DELETE FROM sessions WHERE token = $1", token)
            return None
        return row["username"]


async def delete_session(token: str) -> None:
    assert db_pool is not None
    if not token:
        return
    async with db_pool.acquire() as conn:
        await conn.execute("DELETE FROM sessions WHERE token = $1", token)


async def send_chat_history(ws: websockets.WebSocketServerProtocol, current_user: str) -> None:
    assert db_pool is not None
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sender_username, recipient_username, content, created_at
            FROM messages
            WHERE recipient_username IS NULL
               OR LOWER(sender_username) = LOWER($1)
               OR LOWER(recipient_username) = LOWER($1)
            ORDER BY id DESC
            LIMIT 150
            """,
            current_user,
        )
    items = []
    for r in reversed(rows):
        items.append(
            {
                "sender": r["sender_username"],
                "to": r["recipient_username"],
                "text": r["content"],
                "time": r["created_at"].isoformat(),
            }
        )
    await send_json(ws, {"type": "HISTORY", "messages": items})


async def complete_login(ws: websockets.WebSocketServerProtocol, username: str, token: str | None = None) -> None:
    session_token = token or await create_session(username)
    active_sockets[ws]["user"] = username
    await send_json(
        ws,
        {
            "type": "AUTH_OK",
            "username": username,
            "token": session_token,
        },
    )
    await send_json(
        ws,
        {
            "type": "WELCOME",
            "username": username,
            "message": "Welcome to PyChat!",
        },
    )
    await send_chat_history(ws, username)
    await broadcast_online_users()


async def handle_register(ws: websockets.WebSocketServerProtocol, data: dict) -> None:
    assert db_pool is not None
    username = normalize_username(data.get("username", ""))
    password = data.get("password", "")

    if not is_valid_username(username):
        await send_json(
            ws,
            {"type": "AUTH_ERROR", "message": "Username 3-20 belgi (harf, raqam, _) bo'lsin."},
        )
        return
    if len(password) < 8:
        await send_json(
            ws,
            {"type": "AUTH_ERROR", "message": "Parol kamida 8 belgidan iborat bo'lsin."},
        )
        return

    salt_hex, digest_hex = create_password_hash(password)
    async with db_pool.acquire() as conn:
        existing = await conn.fetchval(
            "SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)",
            username,
        )
        if existing:
            await send_json(ws, {"type": "AUTH_ERROR", "message": "Username already exists."})
            return

        await conn.execute(
            """
            INSERT INTO users (username, password_salt, password_hash)
            VALUES ($1, $2, $3)
            """,
            username,
            salt_hex,
            digest_hex,
        )

    await complete_login(ws, username)


async def handle_login(ws: websockets.WebSocketServerProtocol, data: dict) -> None:
    assert db_pool is not None
    username = normalize_username(data.get("username", ""))
    password = data.get("password", "")

    if not username or not password:
        await send_json(
            ws,
            {"type": "AUTH_ERROR", "message": "Username va parolni kiriting."},
        )
        return

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT username, password_salt, password_hash FROM users WHERE LOWER(username) = LOWER($1)",
            username,
        )

    if not row or not verify_password(password, row["password_salt"], row["password_hash"]):
        await send_json(
            ws,
            {"type": "AUTH_ERROR", "message": "Username yoki parol noto'g'ri."},
        )
        return

    await complete_login(ws, row["username"])


async def handle_resume_session(ws: websockets.WebSocketServerProtocol, data: dict) -> None:
    token = (data.get("token") or "").strip()
    username = await validate_session(token)
    if not username:
        await send_json(ws, {"type": "SESSION_EXPIRED"})
        return
    await complete_login(ws, username, token=token)


async def handle_logout(ws: websockets.WebSocketServerProtocol, data: dict) -> None:
    token = (data.get("token") or "").strip()
    await delete_session(token)
    active_sockets[ws]["user"] = None
    await broadcast_online_users()


async def handle_message(ws: websockets.WebSocketServerProtocol, data: dict) -> None:
    assert db_pool is not None
    sender = active_sockets.get(ws, {}).get("user")
    if not sender:
        await send_json(ws, {"type": "ERROR", "message": "Avval tizimga kiring."})
        return

    raw_text = data.get("text") or ""
    text = raw_text.strip()
    if not text:
        return

    is_image = text.startswith("data:image/")
    if is_image:
        if len(text) > MAX_IMAGE_CHARS:
            await send_json(ws, {"type": "ERROR", "message": "Rasm hajmi juda katta."})
            return
    elif len(text) > MAX_MESSAGE_CHARS:
        await send_json(ws, {"type": "ERROR", "message": "Xabar juda uzun (max 2000 belgi)."})
        return

    raw_to = normalize_username(data.get("to") or "")
    recipient = raw_to if raw_to and raw_to != "general" and raw_to != sender else None

    created_dt = now_utc()
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO messages (sender_username, recipient_username, content, created_at)
            VALUES ($1, $2, $3, $4)
            """,
            sender,
            recipient,
            text,
            created_dt,
        )

    packet = {
        "type": "MESSAGE",
        "sender": sender,
        "to": recipient,
        "text": text,
        "time": created_dt.isoformat(),
    }

    if recipient:
        # Private DM: only sender and recipient receive this packet
        targets = [
            sock
            for sock, info in active_sockets.items()
            if info.get("user") in (sender, recipient)
        ]
    else:
        # Public general chat: all authenticated sockets
        targets = [
            sock
            for sock, info in active_sockets.items()
            if info.get("user")
        ]

    if targets:
        await asyncio.gather(*(send_json(sock, packet) for sock in targets), return_exceptions=True)


async def ws_handler(ws: websockets.WebSocketServerProtocol) -> None:
    ip = ws.remote_address[0] if ws.remote_address else "unknown"
    active_sockets[ws] = {"user": None, "ip": ip}

    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await send_json(ws, {"type": "ERROR", "message": "Noto'g'ri JSON format."})
                continue

            msg_type = (data.get("type") or "").upper()
            if msg_type == "REGISTER":
                await handle_register(ws, data)
            elif msg_type == "LOGIN":
                await handle_login(ws, data)
            elif msg_type == "RESUME_SESSION":
                await handle_resume_session(ws, data)
            elif msg_type == "LOGOUT":
                await handle_logout(ws, data)
            elif msg_type == "MESSAGE":
                await handle_message(ws, data)
            elif msg_type == "PING":
                await send_json(ws, {"type": "PONG"})
    except ConnectionClosed:
        pass
    finally:
        was_authed = bool(active_sockets.get(ws, {}).get("user"))
        active_sockets.pop(ws, None)
        if was_authed:
            await broadcast_online_users()


async def main() -> None:
    await init_db()
    print(f"PYCHAT SERVER LISTENING on ws://{HOST}:{PORT}")
    async with websockets.serve(ws_handler, HOST, PORT, max_size=2 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())