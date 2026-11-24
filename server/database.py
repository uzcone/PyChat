
import os
import asyncpg


DATABASE_URL = os.environ.get("DATABASE_URL")


async def create_pool():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL environment variable is missing")

    return await asyncpg.create_pool(
        dsn=DATABASE_URL,
        min_size=1,
        max_size=5,
        command_timeout=30
    )


async def create_tables(pool):
    async with pool.acquire() as connection:
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
                sender_id BIGINT NOT NULL REFERENCES users(id),
                recipient_id BIGINT REFERENCES users(id),
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                read_at TIMESTAMPTZ
            );
        """)

    print("PostgreSQL tables are ready.")
