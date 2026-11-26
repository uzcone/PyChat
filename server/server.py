
import asyncio
import asyncpg
import hashlib
import hmac
import json
import os
import secrets
import websockets

from datetime import datetime, timedelta, timezone


# =========================================
# PYCHAT SERVER CONFIGURATION
# =========================================

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8765))

DATABASE_URL = os.environ.get("DATABASE_URL")

SESSION_DAYS = 30
PBKDF2_ITERATIONS = 310000

clients = {}
clients_lock = asyncio.Lock()

db_pool = None


# =========================================
# PACKET HELPERS
# =========================================

def create_packet(packet_type, **data):
    return {
        "type": packet_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **data
    }


async def send_packet(websocket, packet_type, **data):
    try:
        packet = create_packet(packet_type, **data)
        await websocket.send(json.dumps(packet))
    except Exception:
        pass


# =========================================
# PASSWORD HASHING
# =========================================

def hash_password(password):
    salt = secrets.token_hex(16)

    password_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERATIONS
    ).hex()

    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${password_hash}"



def verify_password(password, stored_hash):
    try:
        # NEW FORMAT
        # pbkdf2_sha256$iterations$salt$hash

        if stored_hash.startswith("pbkdf2_sha256$"):
            parts = stored_hash.split("$")

            if len(parts) != 4:
                return False

            iterations = int(parts[1])
            salt = parts[2]
            expected_hash = parts[3]

            actual_hash = hashlib.pbkdf2_hmac(
                "sha256",
                password.encode("utf-8"),
                salt.encode("utf-8"),
                iterations
            ).hex()

            return hmac.compare_digest(
                actual_hash,
                expected_hash
            )

        # OLD FORMAT
        # salt$hash (310000 iterations)

        if "$" in stored_hash:
            salt_hex, expected_hash = stored_hash.split("$", 1)
            salt = bytes.fromhex(salt_hex)

            actual_hash = hashlib.pbkdf2_hmac(
                "sha256",
                password.encode("utf-8"),
                salt,
                310000
            ).hex()

            return hmac.compare_digest(
                actual_hash,
                expected_hash
            )

        # OLDER LEGACY FORMAT
        # salt:hash (100000 iterations)

        if ":" in stored_hash:
            salt, expected_hash = stored_hash.split(":", 1)

            actual_hash = hashlib.pbkdf2_hmac(
                "sha256",
                password.encode("utf-8"),
                salt.encode("utf-8"),
                100000
            ).hex()

            return hmac.compare_digest(
                actual_hash,
                expected_hash
            )

        return False

    except Exception:
        return False



# =========================================
# SESSION HELPERS
# =========================================

def create_session_token():
    return secrets.token_urlsafe(32)


def hash_session_token(token):
    return hashlib.sha256(
        token.encode("utf-8")
    ).hexdigest()


async def create_session(user_id):
    token = create_session_token()
    token_hash = hash_session_token(token)

    expires_at = datetime.now(timezone.utc) + timedelta(
        days=SESSION_DAYS
    )

    async with db_pool.acquire() as connection:
        await connection.execute(
            """
            INSERT INTO sessions (
                user_id,
                token_hash,
                expires_at
            )
            VALUES ($1, $2, $3)
            """,
            user_id,
            token_hash,
            expires_at
        )

    return token, expires_at


async def validate_session(token):
    if not token or not isinstance(token, str):
        return None

    token_hash = hash_session_token(token)

    async with db_pool.acquire() as connection:
        session = await connection.fetchrow(
            """
            SELECT
                sessions.user_id,
                sessions.expires_at,
                users.username,
                users.avatar_type,
                users.avatar_value
            FROM sessions
            JOIN users
                ON users.id = sessions.user_id
            WHERE sessions.token_hash = $1
              AND sessions.expires_at > NOW()
            """,
            token_hash
        )

    return session


async def revoke_session(token):
    if not token:
        return

    token_hash = hash_session_token(token)

    async with db_pool.acquire() as connection:
        await connection.execute(
            """
            DELETE FROM sessions
            WHERE token_hash = $1
            """,
            token_hash
        )


# =========================================
# DATABASE INITIALIZATION
# =========================================

async def init_database():
    global db_pool

    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL environment variable is missing."
        )

    db_pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=1,
        max_size=10
    )

    async with db_pool.acquire() as connection:

        # USERS TABLE

        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(20) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                avatar_type TEXT DEFAULT 'default',
                avatar_value TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
            """
        )

        # MESSAGES TABLE

        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id BIGSERIAL PRIMARY KEY,
                sender_id BIGINT REFERENCES users(id)
                    ON DELETE CASCADE,
                recipient_id BIGINT REFERENCES users(id)
                    ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                read_at TIMESTAMPTZ
            )
            """
        )

        # SESSIONS TABLE

        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL
                    REFERENCES users(id)
                    ON DELETE CASCADE,
                token_hash TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
            """
        )

        await connection.execute(
            """
            CREATE INDEX IF NOT EXISTS
            sessions_token_hash_idx
            ON sessions(token_hash)
            """
        )

        await connection.execute(
            """
            CREATE INDEX IF NOT EXISTS
            messages_created_at_idx
            ON messages(created_at)
            """
        )

    print("Database connected successfully.")
    print("Users, messages and sessions tables are ready.")


# =========================================
# ONLINE USERS
# =========================================

async def online_users():
    async with clients_lock:
        return list(clients.keys())


async def update_users():
    users = await online_users()

    packet = create_packet(
        "USERS",
        users=users,
        count=len(users)
    )

    await broadcast_packet(packet)


# =========================================
# BROADCAST
# =========================================

async def broadcast_packet(packet):
    async with clients_lock:
        connections = [
            client["websocket"]
            for client in clients.values()
        ]

    if not connections:
        return

    message = json.dumps(packet)

    await asyncio.gather(
        *[
            websocket.send(message)
            for websocket in connections
        ],
        return_exceptions=True
    )


async def broadcast_message(username, message):
    packet = create_packet(
        "MESSAGE",
        username=username,
        message=message
    )

    await broadcast_packet(packet)


# =========================================
# CONNECTION MANAGEMENT
# =========================================

async def register_connection(
    websocket,
    username,
    user_id,
    token_hash
):
    old_websocket = None

    async with clients_lock:
        old_client = clients.get(username)

        if old_client:
            old_websocket = old_client["websocket"]

        clients[username] = {
            "websocket": websocket,
            "user_id": user_id,
            "token_hash": token_hash
        }

    if old_websocket and old_websocket != websocket:
        try:
            await old_websocket.close(
                code=4001,
                reason="New connection established."
            )
        except Exception:
            pass


async def remove_connection(websocket, username):
    removed = False

    async with clients_lock:
        current_client = clients.get(username)

        if (
            current_client
            and current_client["websocket"] == websocket
        ):
            del clients[username]
            removed = True

    if removed:
        await update_users()


# =========================================
# MESSAGE HISTORY
# =========================================

async def send_history(websocket):
    async with db_pool.acquire() as connection:
        rows = await connection.fetch(
            """
            SELECT
                users.username,
                messages.content,
                messages.created_at
            FROM messages
            JOIN users
                ON users.id = messages.sender_id
            WHERE messages.recipient_id IS NULL
            ORDER BY messages.created_at DESC
            LIMIT 50
            """
        )

    rows = list(reversed(rows))

    history = []

    for row in rows:
        history.append({
            "username": row["username"],
            "message": row["content"],
            "timestamp": row["created_at"].isoformat()
        })

    await send_packet(
        websocket,
        "HISTORY",
        messages=history
    )


# =========================================
# AUTHENTICATION
# =========================================

async def authenticate_register(packet):
    username = str(packet.get("username", "")).strip()
    password = str(packet.get("password", ""))

    avatar_type = str(
        packet.get("avatar_type", "default")
    )

    avatar_value = str(
        packet.get("avatar_value", "")
    )

    if not username or not password:
        return None, "Username and password are required."

    if len(username) > 20:
        return None, "Username must be 20 characters or less."

    if len(password) < 6:
        return None, "Password must contain at least 6 characters."

    password_hash = hash_password(password)

    try:
        async with db_pool.acquire() as connection:
            user = await connection.fetchrow(
                """
                INSERT INTO users (
                    username,
                    password_hash,
                    avatar_type,
                    avatar_value
                )
                VALUES ($1, $2, $3, $4)
                RETURNING
                    id,
                    username,
                    avatar_type,
                    avatar_value
                """,
                username,
                password_hash,
                avatar_type,
                avatar_value
            )

        return user, None

    except asyncpg.UniqueViolationError:
        return None, "This username is already taken."

    except Exception as error:
        print("REGISTER ERROR:", error)
        return None, "Registration failed. Please try again."


async def authenticate_login(packet):
    username = str(packet.get("username", "")).strip()
    password = str(packet.get("password", ""))

    if not username or not password:
        return None, "Username and password are required."

    async with db_pool.acquire() as connection:
        user = await connection.fetchrow(
            """
            SELECT
                id,
                username,
                password_hash,
                avatar_type,
                avatar_value
            FROM users
            WHERE username = $1
            """,
            username
        )

    if not user:
        return None, "Incorrect username or password."

    if not verify_password(password, user["password_hash"]):
        return None, "Incorrect username or password."

    return user, None


# =========================================
# COMPLETE AUTHENTICATION
# =========================================

async def finish_authentication(
    websocket,
    user,
    token,
    expires_at
):
    username = user["username"]
    user_id = user["id"]

    token_hash = hash_session_token(token)

    await register_connection(
        websocket,
        username,
        user_id,
        token_hash
    )

    await send_packet(
        websocket,
        "WELCOME",
        username=username,
        message="Successfully connected to PyChat.",
        token=token,
        expires_at=expires_at.isoformat(),
        avatar_type=user.get("avatar_type", "default"),
        avatar_value=user.get("avatar_value", "")
    )

    await send_history(websocket)
    await update_users()

    return username


# =========================================
# AUTHENTICATION HANDSHAKE
# =========================================

async def authenticate_connection(websocket):
    try:
        raw_packet = await asyncio.wait_for(
            websocket.recv(),
            timeout=30
        )

        packet = json.loads(raw_packet)

        if not isinstance(packet, dict):
            await send_packet(
                websocket,
                "ERROR",
                message="Invalid request."
            )
            return None

        packet_type = packet.get("type")

        # REGISTER

        if packet_type == "REGISTER":
            user, error = await authenticate_register(packet)

            if error:
                await send_packet(
                    websocket,
                    "ERROR",
                    message=error
                )
                return None

            token, expires_at = await create_session(user["id"])

            return await finish_authentication(
                websocket,
                user,
                token,
                expires_at
            )

        # LOGIN

        if packet_type == "LOGIN":
            user, error = await authenticate_login(packet)

            if error:
                await send_packet(
                    websocket,
                    "ERROR",
                    message=error
                )
                return None

            token, expires_at = await create_session(user["id"])

            return await finish_authentication(
                websocket,
                user,
                token,
                expires_at
            )

        # RESUME EXISTING SESSION

        if packet_type == "RESUME":
            token = packet.get("token")

            session = await validate_session(token)

            if not session:
                await send_packet(
                    websocket,
                    "ERROR",
                    code="SESSION_INVALID",
                    message="Your session has expired. Please sign in again."
                )
                return None

            user = {
                "id": session["user_id"],
                "username": session["username"],
                "avatar_type": session["avatar_type"],
                "avatar_value": session["avatar_value"]
            }

            return await finish_authentication(
                websocket,
                user,
                token,
                session["expires_at"]
            )

        await send_packet(
            websocket,
            "ERROR",
            message="Please sign in first."
        )

        return None

    except asyncio.TimeoutError:
        await send_packet(
            websocket,
            "ERROR",
            message="Authentication timed out."
        )
        return None

    except json.JSONDecodeError:
        await send_packet(
            websocket,
            "ERROR",
            message="Invalid JSON request."
        )
        return None

    except Exception as error:
        print("AUTHENTICATION ERROR:", error)

        await send_packet(
            websocket,
            "ERROR",
            message="Authentication failed."
        )

        return None


# =========================================
# CLIENT HANDLER
# =========================================

async def handle_client(websocket):
    username = None

    try:
        username = await authenticate_connection(websocket)

        if not username:
            return

        print(f"{username} connected.")

        async for raw_message in websocket:
            try:
                packet = json.loads(raw_message)

                if not isinstance(packet, dict):
                    continue

                packet_type = packet.get("type")

                # SEND MESSAGE

                if packet_type == "MESSAGE":
                    message = str(
                        packet.get("message", "")
                    ).strip()

                    if not message:
                        continue

                    if len(message) > 1000:
                        await send_packet(
                            websocket,
                            "ERROR",
                            message="Message is too long."
                        )
                        continue

                    async with clients_lock:
                        client = clients.get(username)

                        if (
                            not client
                            or client["websocket"] != websocket
                        ):
                            continue

                        user_id = client["user_id"]

                    async with db_pool.acquire() as connection:
                        await connection.execute(
                            """
                            INSERT INTO messages (
                                sender_id,
                                recipient_id,
                                content
                            )
                            VALUES ($1, NULL, $2)
                            """,
                            user_id,
                            message
                        )

                    await broadcast_message(
                        username,
                        message
                    )

                # PING

                elif packet_type == "PING":
                    await send_packet(
                        websocket,
                        "PONG"
                    )

                # USERS

                elif packet_type == "USERS":
                    users = await online_users()

                    await send_packet(
                        websocket,
                        "USERS",
                        users=users,
                        count=len(users)
                    )

                # LEAVE CONNECTION
                # This does NOT delete the session.

                elif packet_type == "LEAVE":
                    await websocket.close()
                    break

                # LOGOUT
                # This revokes the session.

                elif packet_type == "LOGOUT":
                    async with clients_lock:
                        client = clients.get(username)

                        token_hash = None

                        if (
                            client
                            and client["websocket"] == websocket
                        ):
                            token_hash = client["token_hash"]

                    if token_hash:
                        async with db_pool.acquire() as connection:
                            await connection.execute(
                                """
                                DELETE FROM sessions
                                WHERE token_hash = $1
                                """,
                                token_hash
                            )

                    await send_packet(
                        websocket,
                        "NOTICE",
                        message="You have been signed out."
                    )

                    await websocket.close()
                    break

            except json.JSONDecodeError:
                await send_packet(
                    websocket,
                    "ERROR",
                    message="Invalid message format."
                )

            except Exception as error:
                print("MESSAGE ERROR:", error)

                await send_packet(
                    websocket,
                    "ERROR",
                    message="Unable to process your request."
                )

    except websockets.exceptions.ConnectionClosed:
        pass

    except Exception as error:
        print("CLIENT ERROR:", error)

    finally:
        if username:
            await remove_connection(
                websocket,
                username
            )

            print(f"{username} disconnected.")



# =========================================
# MAIN SERVER
# =========================================

async def main():
    await init_database()

    print("----------------------------------")
    print("       PYCHAT SERVER STARTED")
    print("----------------------------------")
    print(f"Host: {HOST}")
    print(f"Port: {PORT}")
    print(f"Session duration: {SESSION_DAYS} days")
    print("----------------------------------")

    async with websockets.serve(
        handle_client,
        HOST,
        PORT,
        max_size=64 * 1024,
        ping_interval=20,
        ping_timeout=20
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())

    except KeyboardInterrupt:
        print("PyChat server stopped.")

    except Exception as error:
        print("SERVER ERROR:", error)
