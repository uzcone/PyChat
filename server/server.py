
import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import asyncpg
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed


# =====================================
# PYCHAT SERVER CONFIGURATION
# =====================================

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8765))

DATABASE_URL = os.environ.get("DATABASE_URL")

MAX_USERNAME_LENGTH = 20
MAX_MESSAGE_LENGTH = 1000
HISTORY_LIMIT = 50

clients = {}
db_pool = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)


# =====================================
# DATABASE
# =====================================

async def init_database():
    global db_pool

    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is missing")

    db_pool = await asyncpg.create_pool(
        dsn=DATABASE_URL,
        min_size=1,
        max_size=5,
        command_timeout=30
    )

    async with db_pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(20) NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        """)

    logging.info("PostgreSQL connected successfully")


async def save_message(username, message):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO chat_messages
                (username, message)
            VALUES ($1, $2)
            RETURNING id, created_at
        """, username, message)

    return row


async def get_message_history():
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT username, message, created_at
            FROM (
                SELECT id, username, message, created_at
                FROM chat_messages
                ORDER BY id DESC
                LIMIT $1
            ) AS recent
            ORDER BY id ASC
        """, HISTORY_LIMIT)

    return rows


# =====================================
# PROTOCOL
# =====================================

def create_packet(packet_type, **data):
    return json.dumps({
        "type": packet_type,
        "timestamp": datetime.now(
            timezone.utc
        ).isoformat(timespec="seconds"),
        **data
    }, ensure_ascii=False)


async def send_packet(ws, packet_type, **data):
    await ws.send(create_packet(packet_type, **data))


# =====================================
# ONLINE USERS
# =====================================

def online_users():
    return list(clients.values())


async def broadcast(packet_type, **data):
    if not clients:
        return

    packet = create_packet(packet_type, **data)
    connections = list(clients.keys())

    results = await asyncio.gather(
        *(ws.send(packet) for ws in connections),
        return_exceptions=True
    )

    for ws, result in zip(connections, results):
        if isinstance(result, Exception):
            clients.pop(ws, None)
            logging.warning("Inactive client removed")


async def update_users():
    await broadcast(
        "USERS",
        users=online_users(),
        count=len(clients)
    )


# =====================================
# CLIENT HANDLER
# =====================================

async def handle_client(ws):
    username = None

    logging.info("New client connected")

    try:
        # First packet must be JOIN
        try:
            raw = await asyncio.wait_for(
                ws.recv(), timeout=30
            )
            data = json.loads(raw)

        except asyncio.TimeoutError:
            await send_packet(
                ws, "ERROR", message="JOIN timeout"
            )
            return

        except (json.JSONDecodeError, TypeError):
            await send_packet(
                ws, "ERROR", message="Invalid JSON"
            )
            return

        if not isinstance(data, dict):
            await send_packet(
                ws, "ERROR", message="Invalid packet"
            )
            return

        if data.get("type") != "JOIN":
            await send_packet(
                ws, "ERROR", message="JOIN required"
            )
            return

        username = data.get("username", "")

        if not isinstance(username, str):
            await send_packet(
                ws, "ERROR", message="Invalid username"
            )
            return

        username = username.strip()

        if not username or len(username) > MAX_USERNAME_LENGTH:
            await send_packet(
                ws,
                "ERROR",
                message="Username must be 1-20 characters"
            )
            return

        # Check duplicate usernames
        if username.casefold() in [
            name.casefold() for name in clients.values()
        ]:
            await send_packet(
                ws,
                "ERROR",
                message="Username already exists"
            )
            return

        # Register client
        clients[ws] = username

        logging.info("%s joined", username)

        await send_packet(
            ws,
            "WELCOME",
            username=username,
            message=f"Welcome to PyChat, {username}!"
        )

        # Load previous messages
        history = await get_message_history()

        for item in history:
            await send_packet(
                ws,
                "MESSAGE",
                username=item["username"],
                message=item["message"],
                timestamp=item["created_at"].isoformat(
                    timespec="seconds"
                )
            )

        await broadcast(
            "NOTICE",
            message=f"{username} joined the chat"
        )

        await update_users()

        # Receive messages
        async for raw in ws:

            try:
                data = json.loads(raw)

            except (json.JSONDecodeError, TypeError):
                await send_packet(
                    ws, "ERROR", message="Invalid JSON"
                )
                continue

            if not isinstance(data, dict):
                await send_packet(
                    ws, "ERROR", message="Invalid packet"
                )
                continue

            packet_type = data.get("type")

            if packet_type == "MESSAGE":

                message = data.get("message", "")

                if not isinstance(message, str):
                    await send_packet(
                        ws,
                        "ERROR",
                        message="Message must be text"
                    )
                    continue

                message = message.strip()

                if not message:
                    continue

                if len(message) > MAX_MESSAGE_LENGTH:
                    await send_packet(
                        ws,
                        "ERROR",
                        message="Message is too long"
                    )
                    continue

                # Save message to PostgreSQL
                try:
                    saved = await save_message(
                        username, message
                    )

                except Exception:
                    logging.exception(
                        "Message database save failed"
                    )

                    await send_packet(
                        ws,
                        "ERROR",
                        message="Message could not be saved"
                    )
                    continue

                logging.info(
                    "[%s]: %s", username, message
                )

                # Broadcast saved message
                await broadcast(
                    "MESSAGE",
                    username=username,
                    message=message,
                    timestamp=saved["created_at"].isoformat(
                        timespec="seconds"
                    )
                )

            elif packet_type == "USERS":
                await send_packet(
                    ws,
                    "USERS",
                    users=online_users(),
                    count=len(clients)
                )

            elif packet_type == "PING":
                await send_packet(ws, "PONG")

            elif packet_type == "LEAVE":
                await ws.close(
                    code=1000,
                    reason="User left"
                )
                break

            else:
                await send_packet(
                    ws,
                    "ERROR",
                    message="Unknown packet type"
                )

    except ConnectionClosed:
        logging.info(
            "%s disconnected", username or "Unknown client"
        )

    except Exception:
        logging.exception("Client handler error")

    finally:
        if ws in clients:
            left_username = clients.pop(ws)

            logging.info("%s left", left_username)

            await broadcast(
                "NOTICE",
                message=f"{left_username} left the chat"
            )

            await update_users()


# =====================================
# START SERVER
# =====================================

async def main():
    logging.info("Starting PyChat Server...")

    await init_database()

    async with serve(
        handle_client,
        HOST,
        PORT,
        max_size=64 * 1024,
        ping_interval=20,
        ping_timeout=20
    ):
        logging.info(
            "PyChat Server running on port %s", PORT
        )

        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())

    except KeyboardInterrupt:
        logging.info("Server stopped")
