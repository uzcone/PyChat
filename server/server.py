
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
# PYCHAT CONFIGURATION
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
# GENERAL HELPERS
# =========================================

def utc_now():
    return datetime.now(timezone.utc)


def create_packet(packet_type, **kwargs):
    return {"type": packet_type, **kwargs}


async def send_json(websocket, data):
    try:
        await websocket.send(json.dumps(data))
        return True
    except Exception as error:
        print("SEND ERROR:", repr(error))
        return False


async def send_packet(websocket, packet_type, **kwargs):
    return await send_json(
        websocket,
        create_packet(packet_type, **kwargs)
    )


# =========================================
# PASSWORD SECURITY
# =========================================

def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)

    password_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERATIONS
    ).hex()

    return salt, password_hash


def verify_password(password, salt, password_hash):
    _, check_hash = hash_password(password, salt)

    return hmac.compare_digest(
        check_hash,
        password_hash
    )


# =========================================
# SESSION SECURITY
# =========================================

def create_session_token():
    return secrets.token_urlsafe(48)


def hash_session_token(token):
    return hashlib.sha256(
        token.encode("utf-8")
    ).hexdigest()


# =========================================
# DATABASE INITIALIZATION
# =========================================

async def init_database():
    global db_pool

    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is missing in Render Environment."
        )

    print("CONNECTING TO POSTGRESQL...")

    db_pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=1,
        max_size=10,
        command_timeout=30
    )

    async with db_pool.acquire() as connection:

        # USERS TABLE
        await connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                avatar TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ADD AVATAR TO OLD USERS TABLE
        await connection.execute("""
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT ''
        """)

        # SESSIONS TABLE
        await connection.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id)
                    ON DELETE CASCADE,
                token_hash TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # MESSAGES TABLE
        await connection.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # CHECK REQUIRED COLUMNS
        
        for table, columns in required_columns.items():

            existing = await connection.fetch(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = $1
                """,
                table
            )

            existing_names = {
                row["column_name"] for row in existing
            }

            missing = [
                column for column in columns
                if column not in existing_names
            ]

            if missing:
                raise RuntimeError(
                    f"Database table '{table}' is missing "
                    f"columns: {missing}"
                )

            print(
                f"TABLE CHECKED: {table} - OK"
            )

        avatar_exists = await connection.fetchval("""
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users'
                  AND column_name = 'avatar'
            )
        """)

        print("AVATAR COLUMN EXISTS:", avatar_exists)

        if not avatar_exists:
            raise RuntimeError(
                "The users.avatar column is still missing."
            )

        user_count = await connection.fetchval(
            "SELECT COUNT(*) FROM users"
        )

        print("EXISTING USERS:", user_count)

    print("DATABASE INITIALIZED SUCCESSFULLY")


# =========================================
# ONLINE USERS
# =========================================

async def online_users():
    async with clients_lock:
        return list(clients.keys())


async def broadcast_packet(packet):
    async with clients_lock:
        sockets = [
            client["websocket"]
            for client in clients.values()
        ]

    if not sockets:
        return

    await asyncio.gather(
        *[
            send_json(socket, packet)
            for socket in sockets
        ],
        return_exceptions=True
    )


async def update_users():
    users = await online_users()

    print("ONLINE USERS:", users)
    print("ONLINE COUNT:", len(users))

    await broadcast_packet(
        create_packet(
            "USERS",
            users=users,
            count=len(users)
        )
    )


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

        print("USER CONNECTED:", username)
        print("ONLINE:", list(clients.keys()))

    if old_websocket and old_websocket != websocket:
        try:
            await old_websocket.close(
                code=4001,
                reason="New connection established."
            )
        except Exception as error:
            print("OLD CONNECTION ERROR:", repr(error))


async def remove_connection(websocket, username):
    if not username:
        return

    removed = False

    async with clients_lock:

        current = clients.get(username)

        if current and current["websocket"] == websocket:
            del clients[username]
            removed = True

        print("CONNECTION CLOSED:", username)
        print("REMOVED:", removed)

    if removed:
        await update_users()


# =========================================
# USER DATABASE FUNCTIONS
# =========================================

async def get_user(username):
    async with db_pool.acquire() as connection:
        return await connection.fetchrow(
            """
            SELECT
                id,
                username,
                password_salt,
                password_hash,
                avatar,
                created_at
            FROM users
            WHERE username = $1
            """,
            username
        )


async def create_user(username, password):
    salt, password_hash = hash_password(password)

    async with db_pool.acquire() as connection:
        try:
            return await connection.fetchrow(
                """
                INSERT INTO users (
                    username,
                    password_salt,
                    password_hash,
                    avatar
                )
                VALUES ($1, $2, $3, '')
                RETURNING
                    id,
                    username,
                    password_salt,
                    password_hash,
                    avatar,
                    created_at
                """,
                username,
                salt,
                password_hash
            )

        except asyncpg.UniqueViolationError:
            return None


async def update_user_avatar(username, avatar):
    async with db_pool.acquire() as connection:
        await connection.execute(
            """
            UPDATE users
            SET avatar = $1
            WHERE username = $2
            """,
            avatar,
            username
        )


# =========================================
# SESSION DATABASE FUNCTIONS
# =========================================

async def save_session(user_id):
    token = create_session_token()
    token_hash = hash_session_token(token)

    expires_at = utc_now() + timedelta(
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

    return token, token_hash, expires_at


async def get_session(token):
    token_hash = hash_session_token(token)

    async with db_pool.acquire() as connection:
        session = await connection.fetchrow(
            """
            SELECT
                sessions.token_hash,
                sessions.expires_at,
                users.id AS user_id,
                users.username,
                users.avatar
            FROM sessions
            JOIN users
                ON users.id = sessions.user_id
            WHERE sessions.token_hash = $1
            """,
            token_hash
        )

    if not session:
        return None

    if session["expires_at"] <= utc_now():
        await delete_session(token_hash)
        return None

    return session


async def delete_session(token_hash):
    async with db_pool.acquire() as connection:
        await connection.execute(
            """
            DELETE FROM sessions
            WHERE token_hash = $1
            """,
            token_hash
        )


async def delete_user_sessions(user_id):
    async with db_pool.acquire() as connection:
        await connection.execute(
            """
            DELETE FROM sessions
            WHERE user_id = $1
            """,
            user_id
        )


# =========================================
# MESSAGE DATABASE
# =========================================

async def save_message(username, message):
    async with db_pool.acquire() as connection:
        return await connection.fetchrow(
            """
            INSERT INTO messages (
                username,
                message
            )
            VALUES ($1, $2)
            RETURNING
                id,
                username,
                message,
                created_at
            """,
            username,
            message
        )


async def get_message_history(limit=100):
    async with db_pool.acquire() as connection:
        rows = await connection.fetch(
            """
            SELECT
                id,
                username,
                message,
                created_at
            FROM messages
            ORDER BY id DESC
            LIMIT $1
            """,
            limit
        )

    return list(reversed(rows))


async def send_history(websocket):
    messages = await get_message_history()

    history = [
        {
            "id": row["id"],
            "username": row["username"],
            "message": row["message"],
            "time": row["created_at"].isoformat()
        }
        for row in messages
    ]

    await send_packet(
        websocket,
        "HISTORY",
        messages=history
    )


# =========================================
# AUTHENTICATION SUCCESS
# =========================================

async def finish_authentication(
    websocket,
    user,
    token,
    token_hash,
    expires_at
):
    username = user["username"]

    await register_connection(
        websocket,
        username,
        user["id"],
        token_hash
    )

    sent = await send_packet(
        websocket,
        "WELCOME",
        username=username,
        user_id=user["id"],
        token=token,
        expires_at=expires_at.isoformat(),
        avatar=user["avatar"] or ""
    )

    if not sent:
        raise RuntimeError(
            "Could not send WELCOME packet."
        )

    await send_history(websocket)
    await update_users()

    print("AUTHENTICATION SUCCESS:", username)


# =========================================
# AUTHENTICATION
# =========================================

async def authenticate_connection(websocket):

    try:
        raw_message = await asyncio.wait_for(
            websocket.recv(),
            timeout=30
        )

        packet = json.loads(raw_message)

        if not isinstance(packet, dict):
            raise ValueError("Invalid authentication packet.")

        packet_type = packet.get("type")

        # ---------------------------------
        # REGISTER
        # ---------------------------------

        if packet_type == "REGISTER":

            username = str(
                packet.get("username", "")
            ).strip()

            password = str(
                packet.get("password", "")
            )

            if len(username) < 3 or len(username) > 20:
                await send_packet(
                    websocket,
                    "ERROR",
                    message="Username must be 3-20 characters."
                )
                return None

            if len(password) < 6:
                await send_packet(
                    websocket,
                    "ERROR",
                    message="Password must be at least 6 characters."
                )
                return None

            user = await create_user(
                username,
                password
            )

            if user is None:
                await send_packet(
                    websocket,
                    "ERROR",
                    message="Username already exists."
                )
                return None

            token, token_hash, expires_at = await save_session(
                user["id"]
            )

            await finish_authentication(
                websocket,
                user,
                token,
                token_hash,
                expires_at
            )

            return username

        # ---------------------------------
        # LOGIN
        # ---------------------------------

        elif packet_type == "LOGIN":

            username = str(
                packet.get("username", "")
            ).strip()

            password = str(
                packet.get("password", "")
            )

            user = await get_user(username)

            if not user:
                print("LOGIN FAILED: USER NOT FOUND:", username)

                await send_packet(
                    websocket,
                    "ERROR",
                    message="Invalid username or password."
                )
                return None

            if not verify_password(
                password,
                user["password_salt"],
                user["password_hash"]
            ):
                print("LOGIN FAILED: WRONG PASSWORD:", username)

                await send_packet(
                    websocket,
                    "ERROR",
                    message="Invalid username or password."
                )
                return None

            token, token_hash, expires_at = await save_session(
                user["id"]
            )

            await finish_authentication(
                websocket,
                user,
                token,
                token_hash,
                expires_at
            )

            return username

        # ---------------------------------
        # RESUME SESSION
        # ---------------------------------

        elif packet_type == "RESUME":

            token = str(
                packet.get("token", "")
            )

            if not token:
                await send_packet(
                    websocket,
                    "AUTH_REQUIRED",
                    message="Session token is missing."
                )
                return None

            session = await get_session(token)

            if not session:
                await send_packet(
                    websocket,
                    "AUTH_REQUIRED",
                    message="Session expired. Please login again."
                )
                return None

            user = {
                "id": session["user_id"],
                "username": session["username"],
                "avatar": session["avatar"] or ""
            }

            await finish_authentication(
                websocket,
                user,
                token,
                session["token_hash"],
                session["expires_at"]
            )

            return session["username"]

        else:
            await send_packet(
                websocket,
                "ERROR",
                message="Unknown authentication request."
            )
            return None

    except asyncio.TimeoutError:
        print("AUTHENTICATION TIMEOUT")

        await send_packet(
            websocket,
            "ERROR",
            message="Authentication timeout."
        )

        return None

    except Exception as error:
        print("AUTHENTICATION ERROR:", repr(error))

        await send_packet(
            websocket,
            "ERROR",
            message="Authentication failed."
        )

        return None


# =========================================
# MAIN CLIENT HANDLER
# =========================================

async def handle_client(websocket):
    username = None

    print("NEW WEBSOCKET CONNECTION")

    try:
        username = await authenticate_connection(websocket)

        if not username:
            return

        async for raw_message in websocket:

            try:
                packet = json.loads(raw_message)

                if not isinstance(packet, dict):
                    raise ValueError("Packet must be an object.")

            except Exception:
                await send_packet(
                    websocket,
                    "ERROR",
                    message="Invalid JSON."
                )
                continue

            packet_type = packet.get("type")

            # MESSAGE
            if packet_type == "MESSAGE":

                message = str(
                    packet.get("message", "")
                ).strip()

                if not message:
                    continue

                if len(message) > 2000:
                    await send_packet(
                        websocket,
                        "ERROR",
                        message="Message is too long."
                    )
                    continue

                row = await save_message(
                    username,
                    message
                )

                await broadcast_packet(
                    create_packet(
                        "MESSAGE",
                        id=row["id"],
                        username=row["username"],
                        message=row["message"],
                        time=row["created_at"].isoformat()
                    )
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

            # LEAVE
            elif packet_type == "LEAVE":

                print("USER LEFT:", username)

                await websocket.close(
                    code=1000,
                    reason="User left."
                )
                break

            # LOGOUT
            elif packet_type == "LOGOUT":

                async with clients_lock:
                    current = clients.get(username)

                if current and current["websocket"] == websocket:
                    await delete_user_sessions(
                        current["user_id"]
                    )

                await websocket.close(
                    code=1000,
                    reason="User logged out."
                )
                break

            else:
                await send_packet(
                    websocket,
                    "ERROR",
                    message="Unknown packet type."
                )

    except websockets.exceptions.ConnectionClosed as error:
        print("WEBSOCKET CLOSED:", username, repr(error))

    except Exception as error:
        print("CLIENT HANDLER ERROR:", username, repr(error))

    finally:
        await remove_connection(
            websocket,
            username
        )


# =========================================
# SERVER START
# =========================================

async def main():
    print("================================")
    print("PYCHAT SERVER STARTING")
    print("DATABASE URL EXISTS:", bool(DATABASE_URL))
    print("================================")

    try:
        await init_database()

    except Exception as error:
        print("DATABASE INITIALIZATION FAILED:", repr(error))
        raise

    print("================================")
    print("HOST:", HOST)
    print("PORT:", PORT)
    print("SESSION DAYS:", SESSION_DAYS)
    print("PYCHAT SERVER IS STARTING...")
    print("================================")

    try:
        async with websockets.serve(
            handle_client,
            HOST,
            PORT,
            max_size=64 * 1024,
            ping_interval=20,
            ping_timeout=20
        ):
            print("PYCHAT SERVER IS RUNNING")
            await asyncio.Future()

    finally:
        if db_pool:
            await db_pool.close()
            print("DATABASE POOL CLOSED")


# =========================================
# RUN SERVER
# =========================================

if __name__ == "__main__":

    try:
        asyncio.run(main())

    except KeyboardInterrupt:
        print("SERVER STOPPED")

    except Exception as error:
        print("SERVER STARTUP ERROR:", repr(error))
