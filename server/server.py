import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone

import asyncpg
import websockets


# =========================================
# CONFIGURATION
# =========================================

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8765))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

SESSION_DAYS = 30
PBKDF2_ITERATIONS = 310000

clients = {}
clients_lock = asyncio.Lock()
db_pool = None


# =========================================
# HELPERS
# =========================================

def utc_now():
    return datetime.now(timezone.utc)


def make_packet(packet_type, **kwargs):
    return {"type": packet_type, **kwargs}


async def send_packet(ws, packet_type, **kwargs):
    try:
        await ws.send(json.dumps(make_packet(packet_type, **kwargs), default=str))
        return True
    except Exception as exc:
        print("SEND FAILED:", repr(exc))
        return False


def safe_compare(first, second):
    return hmac.compare_digest(
        str(first).strip().lower(),
        str(second).strip().lower(),
    )


# =========================================
# PASSWORD HASHING & LEGACY VERIFICATION
# =========================================

def create_password_hash(password, salt=None):
    if not salt:
        salt = secrets.token_hex(16)

    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        str(salt).encode("utf-8"),
        PBKDF2_ITERATIONS,
    ).hex()

    return str(salt), digest


def verify_password(password, salt, stored_hash):
    if not stored_hash:
        return False

    password_bytes = password.encode("utf-8")
    stored_hash = str(stored_hash).strip()
    salt = str(salt).strip() if salt else ""

    # 1. Current PyChat PBKDF2
    if salt:
        try:
            _, calculated = create_password_hash(password, salt)
            if safe_compare(calculated, stored_hash):
                return True
        except Exception:
            pass

    # 2. Django PBKDF2
    if stored_hash.startswith("pbkdf2_sha256$"):
        try:
            parts = stored_hash.split("$")
            if len(parts) == 4:
                iterations = int(parts[1])
                encoded_salt = parts[2]
                expected = base64.b64decode(parts[3], validate=True)

                calculated = hashlib.pbkdf2_hmac(
                    "sha256",
                    password_bytes,
                    encoded_salt.encode("utf-8"),
                    iterations,
                )
                if hmac.compare_digest(calculated, expected):
                    return True
        except Exception:
            pass

    # 3. Legacy PBKDF2 variants (all iterations)
    if salt:
        for algorithm in ("sha256", "sha1", "sha512"):
            for iterations in (
                10000, 50000, 100000, 120000,
                150000, 200000, 260000,
                310000, 390000, 600000,
            ):
                try:
                    calculated = hashlib.pbkdf2_hmac(
                        algorithm,
                        password_bytes,
                        salt.encode("utf-8"),
                        iterations,
                    ).hex()
                    if safe_compare(calculated, stored_hash):
                        return True
                except Exception:
                    pass

    # 4. Unsalted MD5 / SHA1 / SHA256 / SHA512
    algorithms = {32: "md5", 40: "sha1", 64: "sha256", 128: "sha512"}
    if re.fullmatch(r"[0-9a-fA-F]+", stored_hash):
        algorithm = algorithms.get(len(stored_hash))
        if algorithm:
            try:
                calculated = hashlib.new(algorithm, password_bytes).hexdigest()
                if safe_compare(calculated, stored_hash):
                    return True
            except Exception:
                pass

    # 5. Salted algorithm$salt$hash
    parts = stored_hash.split("$")
    if len(parts) == 3:
        algorithm, encoded_salt, expected = parts
        if algorithm.lower() in ("md5", "sha1", "sha256", "sha512"):
            for candidate in (encoded_salt + password, password + encoded_salt):
                try:
                    calculated = hashlib.new(
                        algorithm.lower(),
                        candidate.encode("utf-8"),
                    ).hexdigest()
                    if safe_compare(calculated, expected):
                        return True
                except Exception:
                    pass

    # 6. bcrypt
    if stored_hash.startswith(("$2a$", "$2b$", "$2y$")):
        try:
            import bcrypt
            return bcrypt.checkpw(password_bytes, stored_hash.encode("utf-8"))
        except Exception:
            pass

    return False


def create_token():
    return secrets.token_urlsafe(48)


def hash_token(token):
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


# =========================================
# DATABASE INIT & QUERIES
# =========================================

async def init_db():
    global db_pool

    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL environment variable is not set.")

    db_pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=1,
        max_size=10,
        command_timeout=30,
    )

    async with db_pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL DEFAULT '',
                avatar TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

        await conn.execute("""
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS password_salt TEXT DEFAULT ''
        """)

        await conn.execute("""
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT ''
        """)

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

        total_users = await conn.fetchval("SELECT COUNT(*) FROM users")
        print(f"DB READY | existing_users={total_users}")


async def get_user_by_username(username):
    async with db_pool.acquire() as conn:
        return await conn.fetchrow(
            """
            SELECT id, username, password_hash, password_salt, avatar, created_at
            FROM users
            WHERE LOWER(username) = LOWER($1)
            """,
            username,
        )


async def create_user_record(username, password):
    salt, pw_hash = create_password_hash(password)

    async with db_pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)",
            username,
        )
        if exists:
            return None

        try:
            return await conn.fetchrow(
                """
                INSERT INTO users (username, password_hash, password_salt, avatar)
                VALUES ($1, $2, $3, '')
                RETURNING id, username, password_hash, password_salt, avatar, created_at
                """,
                username,
                pw_hash,
                salt,
            )
        except asyncpg.UniqueViolationError:
            return None


async def upgrade_user_password(user_id, password):
    salt, pw_hash = create_password_hash(password)
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE users
            SET password_salt = $1, password_hash = $2
            WHERE id = $3
            """,
            salt,
            pw_hash,
            user_id,
        )


async def create_session_record(user_id):
    raw_token = create_token()
    token_hash = hash_token(raw_token)
    expires_at = utc_now() + timedelta(days=SESSION_DAYS)

    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO sessions (user_id, token_hash, expires_at)
            VALUES ($1, $2, $3)
            """,
            user_id,
            token_hash,
            expires_at,
        )

    return raw_token, token_hash, expires_at


async def get_valid_session(raw_token):
    token_hash = hash_token(raw_token)

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                s.token_hash,
                s.expires_at,
                u.id AS user_id,
                u.username,
                u.avatar
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1
            """,
            token_hash,
        )

    if not row:
        return None

    if row["expires_at"] <= utc_now():
        async with db_pool.acquire() as conn:
            await conn.execute("DELETE FROM sessions WHERE token_hash = $1", token_hash)
        return None

    return row


async def delete_user_sessions(user_id):
    async with db_pool.acquire() as conn:
        await conn.execute("DELETE FROM sessions WHERE user_id = $1", user_id)


async def save_chat_message(user_id, content):
    async with db_pool.acquire() as conn:
        return await conn.fetchrow(
            """
            INSERT INTO messages (sender_id, content)
            VALUES ($1, $2)
            RETURNING id, sender_id, content, created_at
            """,
            user_id,
            content,
        )


async def send_recent_history(ws, limit=50):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                m.id,
                m.content,
                m.created_at,
                COALESCE(u.username, 'Unknown') AS username
            FROM messages m
            LEFT JOIN users u ON u.id = m.sender_id
            ORDER BY m.id DESC
            LIMIT $1
            """,
            limit,
        )

    history = [
        {
            "id": r["id"],
            "username": r["username"],
            "message": r["content"],
            "time": r["created_at"].isoformat(),
        }
        for r in reversed(rows)
    ]

    await send_packet(ws, "HISTORY", messages=history)


# =========================================
# ONLINE USERS & BROADCAST
# =========================================

async def get_online_usernames():
    async with clients_lock:
        return list(clients.keys())


async def broadcast(packet_type, **kwargs):
    payload = json.dumps(make_packet(packet_type, **kwargs), default=str)

    async with clients_lock:
        targets = [entry["ws"] for entry in clients.values()]

    if not targets:
        return

    async def _send(target_ws):
        try:
            await target_ws.send(payload)
        except Exception:
            pass

    await asyncio.gather(*[_send(target_ws) for target_ws in targets])


async def notify_online_users():
    users = await get_online_usernames()
    await broadcast("USERS", users=users, count=len(users))


async def add_client(ws, username, user_id):
    old_ws = None

    async with clients_lock:
        existing = clients.get(username)
        if existing:
            old_ws = existing["ws"]

        clients[username] = {
            "ws": ws,
            "user_id": user_id,
        }

    if old_ws and old_ws is not ws:
        try:
            await old_ws.close(code=4001, reason="Logged in from another connection")
        except Exception:
            pass


async def remove_client(ws, username):
    if not username:
        return

    removed = False
    async with clients_lock:
        existing = clients.get(username)
        if existing and existing["ws"] is ws:
            del clients[username]
            removed = True

    if removed:
        await notify_online_users()


# =========================================
# AUTHENTICATION FLOW
# =========================================

async def complete_auth(ws, user_id, username, avatar, token, expires_at):
    await add_client(ws, username, user_id)

    ok = await send_packet(
        ws,
        "WELCOME",
        username=username,
        user_id=user_id,
        token=token,
        expires_at=expires_at.isoformat(),
        avatar=avatar or "",
    )
    if not ok:
        raise RuntimeError("Failed to send WELCOME packet")

    await send_recent_history(ws)
    await notify_online_users()
    print(f"AUTH SUCCESS: {username} (id={user_id})")


async def authenticate(ws):
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=30)
        data = json.loads(raw)

        if not isinstance(data, dict):
            await send_packet(ws, "ERROR", message="Invalid request format.")
            return None

        action = str(data.get("type", "")).strip().upper()

        if action == "REGISTER":
            username = str(data.get("username", "")).strip()
            password = str(data.get("password", ""))

            if not re.fullmatch(r"[a-zA-Z0-9_]{3,30}", username):
                await send_packet(
                    ws,
                    "ERROR",
                    message="Username must be 3-30 letters, numbers, or underscores.",
                )
                return None

            if len(password) < 6:
                await send_packet(
                    ws,
                    "ERROR",
                    message="Password must be at least 6 characters.",
                )
                return None

            user = await create_user_record(username, password)
            if not user:
                await send_packet(ws, "ERROR", message="Username already exists.")
                return None

            token, _, expires_at = await create_session_record(user["id"])
            await complete_auth(
                ws,
                user["id"],
                user["username"],
                user["avatar"],
                token,
                expires_at,
            )
            return user["username"]

        if action == "LOGIN":
            username = str(data.get("username", "")).strip()
            password = str(data.get("password", ""))

            if not username or not password:
                await send_packet(
                    ws,
                    "ERROR",
                    message="Please enter your username and password.",
                )
                return None

            user = await get_user_by_username(username)
            if not user:
                print(f"LOGIN DENIED (no such user): {username!r}")
                await send_packet(ws, "ERROR", message="Invalid username or password.")
                return None

            if not verify_password(password, user["password_salt"], user["password_hash"]):
                print(
                    f"LOGIN DENIED (wrong password): {user['username']!r} | "
                    f"hash_prefix={str(user['password_hash'])[:15]!r} | "
                    f"has_salt={bool(user['password_salt'])}"
                )
                await send_packet(ws, "ERROR", message="Invalid username or password.")
                return None

            expected_salt, expected_hash = create_password_hash(password, user["password_salt"])
            if not user["password_salt"] or not safe_compare(expected_hash, user["password_hash"]):
                await upgrade_user_password(user["id"], password)

            token, _, expires_at = await create_session_record(user["id"])
            await complete_auth(
                ws,
                user["id"],
                user["username"],
                user["avatar"],
                token,
                expires_at,
            )
            return user["username"]

        if action == "RESUME":
            token = str(data.get("token", "")).strip()
            if not token:
                await send_packet(ws, "ERROR", message="Missing session token.")
                return None

            session = await get_valid_session(token)
            if not session:
                await send_packet(
                    ws,
                    "ERROR",
                    message="Session expired. Please sign in again.",
                )
                return None

            await complete_auth(
                ws,
                session["user_id"],
                session["username"],
                session["avatar"],
                token,
                session["expires_at"],
            )
            return session["username"]

        await send_packet(ws, "ERROR", message="Unsupported auth action.")
        return None

    except asyncio.TimeoutError:
        await send_packet(ws, "ERROR", message="Authentication timed out.")
        return None
    except json.JSONDecodeError:
        await send_packet(ws, "ERROR", message="Invalid JSON packet.")
        return None
    except Exception as exc:
        print("AUTH EXCEPTION:", repr(exc))
        await send_packet(ws, "ERROR", message="Authentication error.")
        return None


# =========================================
# CLIENT SESSION LOOP
# =========================================

async def client_handler(ws):
    active_username = None

    try:
        active_username = await authenticate(ws)
        if not active_username:
            return

        async for raw_message in ws:
            try:
                packet = json.loads(raw_message)
            except Exception:
                await send_packet(ws, "ERROR", message="Invalid JSON.")
                continue

            if not isinstance(packet, dict):
                await send_packet(ws, "ERROR", message="Invalid packet.")
                continue

            pkt_type = str(packet.get("type", "")).strip().upper()

            if pkt_type == "MESSAGE":
                text = str(packet.get("message", "")).strip()
                if not text:
                    continue
                if len(text) > 2000:
                    await send_packet(ws, "ERROR", message="Message exceeds 2000 characters.")
                    continue

                async with clients_lock:
                    info = clients.get(active_username)
                    sender_id = info["user_id"] if info else None

                saved = await save_chat_message(sender_id, text)
                await broadcast(
                    "MESSAGE",
                    id=saved["id"],
                    username=active_username,
                    message=saved["content"],
                    time=saved["created_at"].isoformat(),
                )

            elif pkt_type == "PING":
                await send_packet(ws, "PONG")

            elif pkt_type == "USERS":
                users = await get_online_usernames()
                await send_packet(ws, "USERS", users=users, count=len(users))

            elif pkt_type == "LEAVE":
                await ws.close(code=1000, reason="Left chat")
                break

            elif pkt_type == "LOGOUT":
                async with clients_lock:
                    info = clients.get(active_username)
                    uid = info["user_id"] if info and info["ws"] is ws else None

                if uid is not None:
                    await delete_user_sessions(uid)

                await ws.close(code=1000, reason="Logged out")
                break

            else:
                await send_packet(ws, "ERROR", message="Unknown packet type.")

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:
        print(f"CLIENT ERROR ({active_username}):", repr(exc))
    finally:
        await remove_client(ws, active_username)


# =========================================
# ENTRYPOINT
# =========================================

async def main():
    print("STARTING PYCHAT SERVER...")
    await init_db()

    async with websockets.serve(
        client_handler,
        HOST,
        PORT,
        max_size=512 * 1024,
        ping_interval=20,
        ping_timeout=20,
    ):
        print(f"PYCHAT SERVER LISTENING ON {HOST}:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("SERVER STOPPED")
    finally:
        if db_pool is not None:
            try:
                asyncio.run(db_pool.close())
            except Exception:
                pass