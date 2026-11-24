
import asyncio
import json
import logging
import os
from datetime import datetime, timezone

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

# =====================================
# PYCHAT SERVER CONFIGURATION
# =====================================

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8765))

MAX_USERNAME_LENGTH = 20
MAX_MESSAGE_LENGTH = 1000

clients = {}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)

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

        # Validate username
        username = data.get("username", "")

        if not isinstance(username, str):
            await send_packet(
                ws, "ERROR", message="Invalid username"
            )
            return

        username = username.strip()

        if not username or len(username) > MAX_USERNAME_LENGTH:
            await send_packet(
                ws, "ERROR",
                message="Username must be 1-20 characters"
            )
            return

        # Check duplicate usernames
        if username.casefold() in [
            name.casefold() for name in clients.values()
        ]:
            await send_packet(
                ws, "ERROR",
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
                        ws, "ERROR",
                        message="Message must be text"
                    )
                    continue

                message = message.strip()

                if not message:
                    continue

                if len(message) > MAX_MESSAGE_LENGTH:
                    await send_packet(
                        ws, "ERROR",
                        message="Message is too long"
                    )
                    continue

                logging.info(
                    "[%s]: %s", username, message
                )

                await broadcast(
                    "MESSAGE",
                    username=username,
                    message=message
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
                    ws, "ERROR",
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
