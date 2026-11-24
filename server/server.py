
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

# Connected users
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

    return (
        salt.hex() + "$" + hashed.hex()
    )


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
# SEND JSON
# =====================================

async def send_packet(websocket, packet):

    await websocket.send(
        json.dumps(packet, ensure_ascii=False)
    )


# =====================================
# ONLINE USERS
# =====================================

async def broadcast_users():

    users = [
        client["username"]
        for client in clients.values()
    ]

    packet = {
        "type": "USERS",
        "users": users,
        "count": len(users)
    }

    disconnected = []

    for websocket in list(clients.keys()):

        try:
            await send_packet(websocket, packet)

        except ConnectionClosed:
            disconnected.append(websocket)

    for websocket in disconnected:
        clients.pop(websocket, None)


# =====================================
# BROADCAST MESSAGE
# =====================================

async def broadcast_message(packet):

    disconnected = []

    for websocket in list(clients.keys()):

        try:
            await send_packet(websocket, packet)

        except ConnectionClosed:
            disconnected.append(websocket)

    for websocket in disconnected:
        clients.pop(websocket, None)


# =====================================
# AUTHENTICATION
# =====================================

async def authenticate(packet):

    action = packet.get("type")

    username = packet.get("username", "").strip()
    password = packet.get("password", "")

    if not isinstance(username, str):
        raise ValueError("Invalid username.")

    if not isinstance(password, str):
        raise ValueError("Invalid password.")

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

            password_hash = hash_password(password)

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

            if not verify_password(
                password,
                user["password_hash"]
            ):
                raise ValueError(
                    "Incorrect username or password."
                )

            return user

        else:
            raise ValueError("Unknown authentication request.")


# =====================================
# SAVE MESSAGE
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


# =====================================
# HANDLE CLIENT
# =====================================

async def handle_client(websocket):

    user = None
    username = None

    try:

        # FIRST PACKET: LOGIN OR REGISTER

        raw_packet = await asyncio.wait_for(
            websocket.recv(),
            timeout=30
        )

        packet = json.loads(raw_packet)

        user = await authenticate(packet)

        username = user["username"]

        # Prevent duplicate online sessions
        already_online = any(
            client["username"] == username
            for client in clients.values()
        )

        if already_online:
            await send_packet(websocket, {
                "type": "ERROR",
                "message": "This account is already online."
            })
            return

        # Register connected client
        clients[websocket] = {
            "id": user["id"],
            "username": username
        }

        await send_packet(websocket, {
            "type": "WELCOME",
            "username": username,
            "message": "Welcome to PyChat, " + username + "!"
        })

        await broadcast_message({
            "type": "NOTICE",
            "message": username + " joined PyChat."
        })

        await broadcast_users()

        print(username, "connected.")

        # =================================
        # MAIN MESSAGE LOOP
        # =================================

        async for raw_message in websocket:

            try:
                packet = json.loads(raw_message)

            except json.JSONDecodeError:
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

                await broadcast_message({
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
        except ConnectionClosed:
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
        except ConnectionClosed:
            pass

    finally:

        if websocket in clients:

            clients.pop(websocket, None)

            if username:
                print(username, "disconnected.")

                await broadcast_message({
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
