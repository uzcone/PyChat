
import os
import json
import asyncio
import hashlib
import secrets
import re

import asyncpg
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed


# =====================================
# PYCHAT SERVER CONFIGURATION
# =====================================

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8765))
DATABASE_URL = os.environ.get("DATABASE_URL")

SESSION_DAYS = 30

db_pool = None
clients = {}


# =====================================
# PASSWORD SECURITY
# =====================================

def hash_password(password):
    salt = secrets.token_bytes(16)

    hashed = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        310000
    )

    return salt.hex() + "$" + hashed.hex()


def verify_password(password, stored_hash):
    try:
        salt_hex, hash_hex = stored_hash.split("$")
        salt = bytes.fromhex(salt_hex)

        new_hash = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            310000
        )

        return secrets.compare_digest(new_hash.hex(), hash_hex)

    except (ValueError, TypeError):
        return False


# =====================================
# SESSION SECURITY
# =====================================

def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create_session(user_id):
    token = secrets.token_urlsafe(32)
    token_hash = hash_token(token)

    async with db_pool.acquire() as connection:
        await connection.execute("""
            INSERT INTO user_sessions (
                token_hash,
                user_id,
                expires_at
            )
            VALUES (
                $1,
                $2,
                NOW() + INTERVAL '30 days'
            )
        """, token_hash, user_id)

    return token


async def authenticate_session(token):
    if not isinstance(token, str) or len(token) > 200:
        raise ValueError("Invalid session. Please sign in again.")

    token_hash = hash_token(token)

    async with db_pool.acquire() as connection:
        user = await connection.fetchrow("""
            UPDATE user_sessions
            SET expires_at = NOW() + INTERVAL '30 days'
            WHERE token_hash = $1
              AND expires_at > NOW()
            RETURNING user_id
        """, token_hash)

        if not user:
            raise ValueError("Session expired. Please sign in again.")

        account = await connection.fetchrow("""
            SELECT id, username
            FROM users
            WHERE id = $1
        """, user["user_id"])

    if not account:
        raise ValueError("Account not found.")

    return account


async def delete_session(token):
    if not isinstance(token, str):
        return

    async with db_pool.acquire() as connection:
        await connection.execute("""
            DELETE FROM user_sessions
            WHERE token_hash = $1
        """, hash_token(token))


# =====================================
# DATABASE INITIALIZATION
# =====================================

async def init_database():
    global db_pool

    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is missing!")

    db_pool = await asyncpg.create_pool(
        dsn=DATABASE_URL,
        min_size=1,
        max_size=5,
        command_timeout=30
    )

    async with db_pool.acquire() as connection:

        await connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(30) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                avatar_type VARCHAR(20) DEFAULT 'preset',
                avatar_value TEXT DEFAULT 'avatar-1',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        """)

        await connection.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id BIGSERIAL PRIMARY KEY,
                sender_id BIGINT NOT NULL
                    REFERENCES users(id),
                recipient_id BIGINT
                    REFERENCES users(id),
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                read_at TIMESTAMPTZ
            );
        """)

        await connection.execute("""
            CREATE TABLE IF NOT EXISTS user_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL
                    REFERENCES users(id)
                    ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            );
        """)

    print("PostgreSQL connected successfully.")
    print("Session system initialized.")


# =====================================
# SEND JSON
# =====================================

async def send_packet(websocket, packet):
    await websocket.send(
        json.dumps(packet, ensure_ascii=False)
    )


# =====================================
# BROADCAST
# =====================================

async def broadcast_packet(packet):
    disconnected = []

    for websocket in list(clients.keys()):
        try:
            await send_packet(websocket, packet)
        except Exception:
            disconnected.append(websocket)

    for websocket in disconnected:
        clients.pop(websocket, None)


async def broadcast_users():
    users = list(dict.fromkeys(
        client["username"]
        for client in clients.values()
    ))

    await broadcast_packet({
        "type": "USERS",
        "users": users,
        "count": len(users)
    })


# =====================================
# AUTHENTICATION
# =====================================

async def authenticate(packet):
    if not isinstance(packet, dict):
        raise ValueError("Invalid request.")

    action = packet.get("type")

    # RESTORE EXISTING SESSION
    if action == "SESSION":
        token = packet.get("token")
        user = await authenticate_session(token)

        return {
            "user": user,
            "token": token
        }

    username = packet.get("username")
    password = packet.get("password")

    if not isinstance(username, str):
        raise ValueError("Invalid username.")

    if not isinstance(password, str):
        raise ValueError("Invalid password.")

    username = username.strip()

    if not re.fullmatch(r"[a-zA-Z0-9_]{3,30}", username):
        raise ValueError(
            "Username must contain 3-30 letters, numbers or underscores."
        )

    if len(password) < 8 or len(password) > 128:
        raise ValueError(
            "Password must contain 8-128 characters."
        )

    async with db_pool.acquire() as connection:

        if action == "REGISTER":
            password_hash = await asyncio.to_thread(
                hash_password,
                password
            )

            try:
                user = await connection.fetchrow("""
                    INSERT INTO users (
                        username,
                        password_hash
                    )
                    VALUES ($1, $2)
                    RETURNING id, username
                """, username, password_hash)

            except asyncpg.UniqueViolationError:
                raise ValueError("This username is already taken.")

        elif action == "LOGIN":
            user = await connection.fetchrow("""
                SELECT id, username, password_hash
                FROM users
                WHERE username = $1
            """, username)

            if not user:
                raise ValueError(
                    "Incorrect username or password."
                )

            valid = await asyncio.to_thread(
                verify_password,
                password,
                user["password_hash"]
            )

            if not valid:
                raise ValueError(
                    "Incorrect username or password."
                )

        else:
            raise ValueError("Unknown authentication request.")

    token = await create_session(user["id"])

    return {
        "user": user,
        "token": token
    }


# =====================================
# MESSAGE STORAGE
# =====================================

async def save_message(user_id, message):
    async with db_pool.acquire() as connection:
        await connection.execute("""
            INSERT INTO messages (
                sender_id,
                content
            )
            VALUES ($1, $2)
        """, user_id, message)


async def get_recent_messages(limit=50):
    async with db_pool.acquire() as connection:
        rows = await connection.fetch("""
            SELECT u.username, m.content
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.recipient_id IS NULL
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $1
        """, limit)

    return [
        {
            "username": row["username"],
            "message": row["content"]
        }
        for row in reversed(rows)
    ]


# =====================================
# HANDLE CLIENT
# =====================================

async def handle_client(websocket):
    user = None
    username = None

    try:
        raw_packet = await asyncio.wait_for(
            websocket.recv(),
            timeout=30
        )

        packet = json.loads(raw_packet)

        auth = await authenticate(packet)

        user = auth["user"]
        username = user["username"]
        session_token = auth["token"]

        # Multiple connections for the same account are allowed.
        clients[websocket] = {
            "id": user["id"],
            "username": username
        }

        await send_packet(websocket, {
            "type": "WELCOME",
            "username": username,
            "session_token": session_token,
            "message": "Welcome to PyChat, " + username + "!"
        })

        history = await get_recent_messages(limit=50)

        await send_packet(websocket, {
            "type": "HISTORY",
            "messages": history
        })

        await broadcast_packet({
            "type": "NOTICE",
            "message": username + " joined PyChat."
        })

        await broadcast_users()

        print(username, "connected.")

        # MAIN MESSAGE LOOP
        async for raw_message in websocket:

            try:
                packet = json.loads(raw_message)
            except (json.JSONDecodeError, TypeError):
                continue

            if not isinstance(packet, dict):
                continue

            packet_type = packet.get("type")

            # SEND MESSAGE
            if packet_type == "MESSAGE":
                message = packet.get("message", "")

                if not isinstance(message, str):
                    continue

                message = message.strip()

                if not message or len(message) > 1000:
                    continue

                await save_message(user["id"], message)

                await broadcast_packet({
                    "type": "MESSAGE",
                    "username": username,
                    "message": message
                })

            # PING
            elif packet_type == "PING":
                await send_packet(websocket, {
                    "type": "PONG"
                })

            # NORMAL DISCONNECT — KEEP SESSION
            elif packet_type == "LEAVE":
                break

            # EXPLICIT LOGOUT — DELETE THIS SESSION
            elif packet_type == "LOGOUT":
                await delete_session(session_token)
                break

    except ValueError as error:
        try:
            await send_packet(websocket, {
                "type": "ERROR",
                "message": str(error)
            })
        except Exception:
            pass

    except asyncio.TimeoutError:
        print("Authentication timeout.")

    except ConnectionClosed:
        pass

    except Exception as error:
        print("Server error:", str(error))

        try:
            await send_packet(websocket, {
                "type": "ERROR",
                "message": "Server error. Please try again."
            })
        except Exception:
            pass

    finally:
        was_registered = websocket in clients
        clients.pop(websocket, None)

        if was_registered:
            print(username, "disconnected.")

            await broadcast_packet({
                "type": "NOTICE",
                "message": username + " left PyChat."
            })

            await broadcast_users()


# =====================================
# MAIN
# =====================================

async def main():
    await init_database()

    print("PyChat server starting...")

    async with serve(
        handle_client,
        HOST,
        PORT,
        ping_interval=20,
        ping_timeout=20,
        max_size=2**20
    ):
        print("PyChat server running on port", PORT)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
