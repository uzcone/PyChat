
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

db_pool = None

# Active connections:
# {username: {"websocket": websocket, "id": user_id}}

clients = {}

clients_lock = asyncio.Lock()


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

        return secrets.compare_digest(
            new_hash.hex(),
            hash_hex
        )

    except (ValueError, TypeError):
        return False


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

    print("PostgreSQL connected successfully.")


# =====================================
# SEND PACKET
# =====================================

async def send_packet(websocket, packet):
    await websocket.send(
        json.dumps(packet, ensure_ascii=False)
    )


# =====================================
# AUTHENTICATION
# =====================================

async def authenticate(packet):

    action = packet.get("type")

    username = packet.get("username")
    password = packet.get("password")

    if not isinstance(username, str):
        raise ValueError("Invalid username.")

    if not isinstance(password, str):
        raise ValueError("Invalid password.")

    username = username.strip()

    if not re.fullmatch(
        r"[a-zA-Z0-9_]{3,30}",
        username
    ):
        raise ValueError(
            "Username must contain 3-30 letters, numbers or underscores."
        )

    if len(password) < 8 or len(password) > 128:
        raise ValueError(
            "Password must contain 8-128 characters."
        )

    async with db_pool.acquire() as connection:

        # REGISTER
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

                return user

            except asyncpg.UniqueViolationError:
                raise ValueError(
                    "This username is already taken."
                )

        # LOGIN
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

            return user

        else:
            raise ValueError(
                "Unknown authentication request."
            )


# =====================================
# ONLINE USER MANAGEMENT
# =====================================

async def register_connection(username, user_id, websocket):

    old_websocket = None

    async with clients_lock:

        old_client = clients.get(username)

        if old_client:
            old_websocket = old_client["websocket"]

        clients[username] = {
            "id": user_id,
            "websocket": websocket
        }

    # Close old connection AFTER replacing it.
    # Its finally block will not remove the new connection.

    if old_websocket and old_websocket is not websocket:
        try:
            await old_websocket.close(
                code=4001,
                reason="Account reconnected"
            )
        except Exception:
            pass


async def remove_connection(username, websocket):

    removed = False

    async with clients_lock:

        current = clients.get(username)

        # Only remove the connection if it is still
        # the active connection for this username.

        if current and current["websocket"] is websocket:
            clients.pop(username, None)
            removed = True

    return removed


async def get_online_users():

    async with clients_lock:
        return list(clients.keys())


# =====================================
# BROADCAST
# =====================================

async def broadcast_packet(packet):

    async with clients_lock:
        active_connections = [
            (username, client["websocket"])
            for username, client in clients.items()
        ]

    disconnected = []

    for username, websocket in active_connections:

        try:
            await send_packet(websocket, packet)

        except Exception:
            disconnected.append((username, websocket))

    for username, websocket in disconnected:
        await remove_connection(username, websocket)


async def broadcast_users():

    users = await get_online_users()

    await broadcast_packet({
        "type": "USERS",
        "users": users,
        "count": len(users)
    })


# =====================================
# MESSAGE DATABASE
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
            SELECT
                u.username,
                m.content,
                m.created_at
            FROM messages m
            JOIN users u
                ON u.id = m.sender_id
            WHERE m.recipient_id IS NULL
            ORDER BY
                m.created_at DESC,
                m.id DESC
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
    registered = False

    try:

        # FIRST PACKET: LOGIN OR REGISTER

        raw_packet = await asyncio.wait_for(
            websocket.recv(),
            timeout=60
        )

        packet = json.loads(raw_packet)

        if not isinstance(packet, dict):
            raise ValueError("Invalid authentication request.")

        user = await authenticate(packet)

        username = user["username"]

        # Register or replace an existing connection.
        await register_connection(
            username,
            user["id"],
            websocket
        )

        registered = True

        print(username, "connected.")

        # WELCOME

        await send_packet(websocket, {
            "type": "WELCOME",
            "username": username,
            "message": "Welcome to PyChat, " + username + "!"
        })

        # MESSAGE HISTORY

        history = await get_recent_messages(limit=50)

        await send_packet(websocket, {
            "type": "HISTORY",
            "messages": history
        })

        # JOIN NOTICE

        await broadcast_packet({
            "type": "NOTICE",
            "message": username + " joined PyChat."
        })

        await broadcast_users()

        # =================================
        # MAIN MESSAGE LOOP
        # =================================

        async for raw_message in websocket:

            try:
                packet = json.loads(raw_message)

            except json.JSONDecodeError:
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

                await save_message(
                    user["id"],
                    message
                )

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

            # LEAVE

            elif packet_type == "LEAVE":

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

        print("Server error:", repr(error))

        try:
            await send_packet(websocket, {
                "type": "ERROR",
                "message": "Server error. Please try again."
            })

        except Exception:
            pass

    finally:

        if registered and username:

            removed = await remove_connection(
                username,
                websocket
            )

            if removed:

                print(username, "disconnected.")

                await broadcast_packet({
                    "type": "NOTICE",
                    "message": username + " left PyChat."
                })

                await broadcast_users()


# =====================================
# MAIN SERVER
# =====================================

async def main():

    await init_database()

    print("PyChat server starting...")

    async with serve(
        handle_client,
        HOST,
        PORT,
        ping_interval=20,
        ping_timeout=30,
        max_size=2**20
    ):

        print(
            "PyChat server running on port",
            PORT
        )

        await asyncio.Future()


# =====================================
# START
# =====================================

if __name__ == "__main__":
    asyncio.run(main())
