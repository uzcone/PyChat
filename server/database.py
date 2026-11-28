import os
import asyncpg


def get_database_url() -> str:
    url = (os.getenv("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is not set.")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    return url


async def create_pool() -> asyncpg.Pool:
    dsn = get_database_url()
    use_ssl = "localhost" not in dsn and "127.0.0.1" not in dsn
    return await asyncpg.create_pool(
        dsn=dsn,
        min_size=1,
        max_size=5,
        ssl="require" if use_ssl else None,
    )


async def create_tables(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(32) UNIQUE NOT NULL,
                password_salt VARCHAR(64) NOT NULL,
                password_hash VARCHAR(128) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token VARCHAR(128) PRIMARY KEY,
                username VARCHAR(32) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_username VARCHAR(32) NOT NULL,
                recipient_username VARCHAR(32) NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_created_id ON messages (id DESC)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)"
        )