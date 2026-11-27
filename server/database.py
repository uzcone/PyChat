import os
import asyncpg

DATABASE_URL = os.environ.get("DATABASE_URL", "")


async def create_pool() -> asyncpg.Pool:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL environment variable is missing")

    return await asyncpg.create_pool(
        dsn=DATABASE_URL,
        min_size=1,
        max_size=5,
        command_timeout=30,
    )


async def create_tables(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as connection:
        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(30) NOT NULL UNIQUE,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )

        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                username VARCHAR(30) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            );
            """
        )

        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id BIGSERIAL PRIMARY KEY,
                sender_username VARCHAR(30) NOT NULL,
                recipient_username VARCHAR(30),
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )

        await connection.execute(
            """
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS recipient_username VARCHAR(30);
            """
        )

        await connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_messages_recipient
            ON messages (recipient_username);
            """
        )

        await connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_messages_created_at
            ON messages (created_at DESC, id DESC);
            """
        )

        await connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sessions_expires
            ON sessions (expires_at);
            """
        )

    print("PostgreSQL tables are ready.")