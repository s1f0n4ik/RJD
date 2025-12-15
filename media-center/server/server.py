import asyncio
import websockets
from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError

# camera_id -> { "camera": ws, "client": ws }
pairs = {}

async def handle_camera(camera_id, websocket):
    print(f"[CAMERA CONNECTED] {camera_id}")

    pair = pairs.get(camera_id, {"camera": None, "client": None})
    pair["camera"] = websocket
    pairs[camera_id] = pair

    try:
        async for message in websocket:
            client = pair.get("client")
            if client:
                await client.send(message)
    except (ConnectionClosedError, ConnectionClosedOK):
        print(f"[CAMERA DISCONNECTED] {camera_id}")
    finally:
        await cleanup_pair(camera_id)


async def handle_client(camera_id, websocket):
    print(f"[CLIENT CONNECTED] {camera_id}")

    pair = pairs.get(camera_id, {"camera": None, "client": None})
    pair["client"] = websocket
    pairs[camera_id] = pair

    try:
        async for message in websocket:
            camera = pair.get("camera")
            if camera:
                await camera.send(message)
    except (ConnectionClosedError, ConnectionClosedOK):
        print(f"[CLIENT DISCONNECTED] {camera_id}")
    finally:
        await cleanup_pair(camera_id)


async def cleanup_pair(camera_id):
    pair = pairs.get(camera_id)
    if not pair:
        return

    cam = pair.get("camera")
    cli = pair.get("client")

    if cam:
        try:
            await cam.close()
        except:
            pass

    if cli:
        try:
            await cli.close()
        except:
            pass

    pairs.pop(camera_id, None)
    print(f"[PAIR REMOVED] {camera_id}")


async def router(websocket, path):
    """
    Маршрутизация по адресам:
    /camera/<id>
    /client/<id>
    """
    try:
        parts = path.strip("/").split("/")
        if len(parts) != 2:
            await websocket.close()
            return

        role, camera_id = parts

        if role == "camera":
            await handle_camera(camera_id, websocket)
        elif role == "client":
            await handle_client(camera_id, websocket)
        else:
            await websocket.close()
    except Exception as e:
        print("Router error:", e)


async def main():
    print("WebSocket broker running on ws://0.0.0.0:8765")
    async with websockets.serve(router, "0.0.0.0", 8765):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
