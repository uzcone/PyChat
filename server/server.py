
import asyncio
import asyncpg
import base64
import hashlib
import hmac
import json
import os
import re
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

DB_COLUMNS = {}


# =========================================
# GENERAL HELPERS
# =========================================

def utc_now():
    return datetime.now(timezone.utc)


def create_packet(packet_type, **kwargs):
    return {"type": packet_type, **kwargs}


def field_value(record, key, default=""):
    if record is None:
        return default

    try:
        value = record[key]
        return default if value is None else value
    except (KeyError, TypeError, IndexError):
        return default


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

    result = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERATIONS
    ).hex()

    return salt, result


def verify_password(password, salt, stored_hash):
    if not stored_hash:
        return False

    password_bytes = password.encode("utf-8")
    stored_hash = str(stored_hash).strip()

    # 1. Current PyChat PBKDF2
    if salt:
        try:
            _, calculated = hash_password(
                password,
                str(salt)
            )

            if hmac.compare_digest(
                calculated.lower(),
                stored_hash.lower()
            ):
                return True

        except Exception as error:
            print("CURRENT HASH CHECK ERROR:", repr(error))

    # 2. Django PBKDF2 format
    if stored_hash.startswith("pbkdf2_sha256$"):
        try:
            parts = stored_hash.split("$")

            if len(parts) != 4:
                return False

            iterations = int(parts[1])
            encoded_salt = parts[2]
            expected = base64.b64decode(
                parts[3],
                validate=True
            )

            calculated = hashlib.pbkdf2_hmac(
                "sha256",
                password_bytes,
                encoded_salt.encode("utf-8"),
                iterations
            )

            return hmac.compare_digest(
                calculated,
                expected
            )

        except Exception as error:
            print("PBKDF2 LEGACY CHECK ERROR:", repr(error))
            return False

    # 3. Common unsalted legacy hashes
    algorithms = {
        32: "md5",
        40: "sha1",
        64: "sha256",
        128: "sha512"
    }

    if re.fullmatch(r"[0-9a-fA-F]+", stored_hash):
        algorithm = algorithms.get(len(stored_hash))

        if algorithm:
            try:
                calculated = hashlib.new(
                    algorithm,
                    password_bytes
                ).hexdigest()

                if hmac.compare_digest(
                    calculated.lower(),
                    stored_hash.lower()
                ):
                    return True

            except Exception as error:
                print("LEGACY HASH CHECK ERROR:", repr(error))

    # 4. Salted SHA / MD5 formats:
    # algorithm$salt$hash
    parts = stored_hash.split("$")

    if len(parts) == 3:
        algorithm, encoded_salt, expected = parts

        if algorithm.lower() in (
            "md5",
            "sha1",
            "sha256",
            "sha512"
        ):
            try:
                algorithm = algorithm.lower()

                candidates = [
                    encoded_salt + password,
                    password + encoded_salt
                ]

                for candidate in candidates:
                    calculated = hashlib.new(
                        algorithm,
                        candidate.encode("utf-8")
                    ).hexdigest()

                    if hmac.compare_digest(
                        calculated.lower(),
                        expected.lower()
                    ):
                        return True

            except Exception as error:
                print("SALTED HASH CHECK ERROR:", repr(error))

    # 5. Optional bcrypt support
    if stored_hash.startswith(("$2a$", "$2b$", "$2y$")):
        try:
            import bcrypt

            return bcrypt.checkpw(
                password_bytes,
                stored_hash.encode("utf-8")
            )

        except ImportError:
            print("BCRYPT SUPPORT NOT INSTALLED")
        except Exception as error:
            print("BCRYPT CHECK ERROR:", repr(error))

    return False


def is_current_password_hash(password, salt, stored_hash):
    if not salt or not stored_hash:
        return False

    _, calculated = hash_password(
        password,
        str(salt)
    )

    return hmac.compare_digest(
        calculated.lower(),
        str(stored_hash).lower()
    )


async def upgrade_password_hash(user_id, password):
    salt, new_hash = hash_password(password)

    async with db_pool.acquire() as connection:
        await connection.execute("""
            UPDATE users
            SET password_salt = $1,
                password_hash = $2
            WHERE id = $3
        """,
            salt,
            new_hash,
            user_id
        )

    print("PASSWORD HASH UPGRADED FOR USER ID:", user_id)


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
# DATABASE HELPERS
# =========================================

async def load_database_columns(connection):
    global DB_COLUMNS

    rows = await connection.fetch("""
        SELECT
            table_name,
            column_name,
            is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('users', 'sessions', 'messages')
        ORDER BY table_name, ordinal_position
    """)

    DB_COLUMNS = {}

    for row in rows:
        table = row["table_name"]

        DB_COLUMNS.setdefault(table, {})

        DB_COLUMNS[table][row["column_name"]] = {
            "nullable": row["is_nullable"] == "YES"
        }

    for table, columns in DB_COLUMNS.items():
        print(
            "DATABASE TABLE:",
            table,
            "COLUMNS:",
            list(columns.keys())
        )


def require_columns(table, required):
    existing = DB_COLUMNS.get(table, {})

    missing = [
        column
        for column in required
        if column not in existing
    ]

    if missing:
        raise RuntimeError(
            f"Table {table} is missing columns: {missing}"
        )


# =========================================
# DATABASE INITIALIZATION
# =========================================

async def init_database():
    global db_pool

    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is missing.")

    print("CONNECTING TO POSTGRESQL...")

    db_pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=1,
        max_size=10,
        command_timeout=30
    )

    async with db_pool.acquire() as connection:

        # USERS
        await connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT,
                avatar_type TEXT DEFAULT '',
                avatar_value TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # Safe additions to existing users table
        await connection.execute("""
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS password_salt TEXT
        """)

        await connection.execute("""
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT ''
        """)

        # SESSIONS
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

        # MESSAGES
        await connection.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id),
                recipient_id INTEGER REFERENCES users(id),
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                read_at TIMESTAMPTZ
            )
        """)

        await load_database_columns(connection)

        require_columns(
            "users",
            [
                "id",
                "username",
                "password_hash",
                "password_salt",
                "avatar",
                "avatar_type",
                "avatar_value",
                "created_at"
            ]
        )

        require_columns(
            "sessions",
            [
                "id",
                "user_id",
                "token_hash",
                "expires_at",
                "created_at"
            ]
        )

        require_columns(
            "messages",
            [
                "id",
                "sender_id",
                "recipient_id",
                "content",
                "created_at"
            ]
        )

        user_count = await connection.fetchval(
            "SELECT COUNT(*) FROM users"
        )

        message_count = await connection.fetchval(
            "SELECT COUNT(*) FROM messages"
        )

        print("EXISTING USERS:", user_count)
        print("EXISTING MESSAGES:", message_count)

        # Safe password format summary.
        # Never print actual password hashes.
        formats = await connection.fetch("""
            SELECT
                LENGTH(password_hash) AS hash_length,
                CASE
                    WHEN password_hash LIKE 'pbkdf2_sha256$%'
                        THEN 'django_pbkdf2'
                    WHEN password_hash LIKE '$2%'
                        THEN 'bcrypt'
                    WHEN password_hash ~ '^[0-9a-fA-F]+$'
                        THEN 'hex_hash'
                    ELSE 'other'
                END AS hash_format,
                CASE
                    WHEN password_salt IS NULL OR password_salt = ''
                        THEN 'no_salt'
                    ELSE 'has_salt'
                END AS salt_status,
                COUNT(*) AS total
            FROM users
            GROUP BY 1, 2, 3
            ORDER BY total DESC
        """)

        for row in formats:
            print("PASSWORD FORMAT SUMMARY:", dict(row))

    print("DATABASE INITIALIZED SUCCESSFULLY")


# =========================================
# USER HELPERS
# =========================================

def get_avatar(user):
    if not user:
        return ""

    return (
        field_value(user, "avatar")
        or field_value(user, "avatar_value")
        or ""
    )


async def get_user(username):
    async with db_pool.acquire() as connection:
        return await connection.fetchrow("""
            SELECT
                id,
                username,
                password_salt,
                password_hash,
                avatar,
                avatar_type,
                avatar_value,
                created_at
            FROM users
            WHERE username = $1
        """, username)


async def create_user(username, password):
    salt, password_hash = hash_password(password)

    async with db_pool.acquire() as connection:
        try:
            return await connection.fetchrow("""
                INSERT INTO users (
                    username,
                    password_salt,
                    password_hash,
                    avatar,
                    avatar_type,
                    avatar_value
                )
                VALUES ($1, $2, $3, '', '', '')
                RETURNING *
            """,
                username,
                salt,
                password_hash
            )

        except asyncpg.UniqueViolationError:
            return None


async def update_user_avatar(username, avatar):
    async with db_pool.acquire() as connection:
        await connection.execute("""
            UPDATE users
            SET avatar = $1,
                avatar_value = $1
            WHERE username = $2
        """, avatar, username)


# =========================================
# SESSION DATABASE
# =========================================

async def save_session(user_id):
    token = create_session_token()
    token_hash = hash_session_token(token)

    expires_at = utc_now() + timedelta(
        days=SESSION_DAYS
    )

    async with db_pool.acquire() as connection:
        await connection.execute("""
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
        session = await connection.fetchrow("""
            SELECT
                sessions.token_hash,
                sessions.expires_at,
                users.id AS user_id,
                users.username,
                users.avatar,
                users.avatar_type,
                users.avatar_value
            FROM sessions
            JOIN users
                ON users.id = sessions.user_id
            WHERE sessions.token_hash = $1
        """, token_hash)

    if not session:
        return None

    if session["expires_at"] <= utc_now():
        await delete_session(token_hash)
        return None

    return session


async def delete_session(token_hash):
    async with db_pool.acquire() as connection:
        await connection.execute("""
            DELETE FROM sessions
            WHERE token_hash = $1
        """, token_hash)


async def delete_user_sessions(user_id):
    async with db_pool.acquire() as connection:
        await connection.execute("""
            DELETE FROM sessions
            WHERE user_id = $1
        """, user_id)


# =========================================
# ONLINE USERS
# =========================================

async def online_users():
    async with clients_lock:
        return list(clients.keys())


async def broadcast_packet(packet):
    async with clients_lock:
        sockets = [
            item["websocket"]
            for item in clients.values()
        ]

    if sockets:
        await asyncio.gather(
            *[
                send_json(socket, packet)
                for socket in sockets
            ],
            return_exceptions=True
        )


async def update_users():
    users = await online_users()

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

    if removed:
        print("USER DISCONNECTED:", username)
        await update_users()


# =========================================
# MESSAGE DATABASE
# =========================================

async def save_message(username, message):
    async with db_pool.acquire() as connection:

        user_id = await connection.fetchval("""
            SELECT id
            FROM users
            WHERE username = $1
        """, username)

        if user_id is None:
            raise RuntimeError("Message sender not found.")

        recipient_nullable = (
            DB_COLUMNS["messages"]["recipient_id"]["nullable"]
        )

        recipient_id = None

        if not recipient_nullable:
            recipient_id = user_id
            print(
                "WARNING: recipient_id is NOT NULL; "
                "using sender_id as fallback."
            )

        return await connection.fetchrow("""
            INSERT INTO messages (
                sender_id,
                recipient_id,
                content
            )
            VALUES ($1, $2, $3)
            RETURNING id, sender_id, recipient_id, content, created_at
        """,
            user_id,
            recipient_id,
            message
        )


async def get_message_history(limit=100):
    async with db_pool.acquire() as connection:
        rows = await connection.fetch("""
            SELECT
                messages.id,
                messages.sender_id,
                messages.recipient_id,
                messages.content,
                messages.created_at,
                users.username
            FROM messages
            LEFT JOIN users
                ON users.id = messages.sender_id
            ORDER BY messages.id DESC
            LIMIT $1
        """, limit)

    return list(reversed(rows))


async def send_history(websocket):
    rows = await get_message_history()

    history = [
        {
            "id": row["id"],
            "username": row["username"] or "Unknown",
            "message": row["content"],
            "time": row["created_at"].isoformat()
        }
        for row in rows
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
    username = field_value(user, "username")

    await register_connection(
        websocket,
        username,
        field_value(user, "id"),
        token_hash
    )

    sent = await send_packet(
        websocket,
        "WELCOME",
        username=username,
        user_id=field_value(user, "id"),
        token=token,
        expires_at=expires_at.isoformat(),
        avatar=get_avatar(user),
        avatar_type=field_value(user, "avatar_type"),
        avatar_value=field_value(user, "avatar_value")
    )

    if not sent:
        raise RuntimeError("WELCOME packet could not be sent.")

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

        # REGISTER
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

        # LOGIN
        elif packet_type == "LOGIN":

            username = str(
                packet.get("username", "")
            ).strip()

            password = str(
                packet.get("password", "")
            )

            user = await get_user(username)

            if not user:
                print("LOGIN FAILED: USER NOT FOUND")

                await send_packet(
                    websocket,
                    "ERROR",
                    message="Invalid username or password."
                )
                return None

            stored_salt = field_value(
                user,
                "password_salt",
                None
            )

            stored_hash = field_value(
                user,
                "password_hash",
                None
            )

            valid = verify_password(
                password,
                stored_salt,
                stored_hash
            )

            if not valid:
                # Only safe metadata is logged.
                hash_text = str(stored_hash or "")

                print(
                    "LOGIN FAILED:",
                    {
                        "user_found": True,
                        "hash_length": len(hash_text),
                        "hash_is_hex": bool(
                            re.fullmatch(
                                r"[0-9a-fA-F]+",
                                hash_text
                            )
                        ),
                        "hash_has_separator": "$" in hash_text,
                        "salt_exists": bool(stored_salt),
                        "salt_length": len(str(stored_salt))
                        if stored_salt else 0
                    }
                )

                await send_packet(
                    websocket,
                    "ERROR",
                    message="Invalid username or password."
                )
                return None

            # Upgrade every successfully verified legacy hash.
            # Current hashes are left unchanged.
            if not is_current_password_hash(
                password,
                stored_salt,
                stored_hash
            ):
                await upgrade_password_hash(
                    user["id"],
                    password
                )

                user = await get_user(username)

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

        # RESUME
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
                "avatar": session["avatar"],
                "avatar_type": session["avatar_type"],
                "avatar_value": session["avatar_value"]
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
                    raise ValueError("Invalid packet.")

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
                        username=username,
                        message=row["content"],
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
        print(
            "DATABASE INITIALIZATION FAILED:",
            repr(error)
        )
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
