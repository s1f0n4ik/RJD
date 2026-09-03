"""Прокси /d/{deviceId}/... на сервисы устройства.

Сервисы устройства: mc — REST media-center (7777), storage — storage-service
(8001), signaling — WebRTC-сигналинг (8765, WebSocket). Само видео идёт
WebRTC-пиром мимо прокси, здесь только управляющий трафик.
"""

import asyncio
import logging

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from app.config import settings
from app.services.devices import registry

router = APIRouter()
logger = logging.getLogger(__name__)

# Склейка записей на storage-service может идти минутами
_proxy_client = httpx.AsyncClient(
    timeout=httpx.Timeout(600.0, connect=3.0)
)

# Заголовки соединения не проксируются
_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


def _service_port(service: str) -> int:
    if service == "mc":
        return settings.DEVICE_MC_PORT
    if service == "storage":
        return settings.DEVICE_STORAGE_PORT
    raise HTTPException(status_code=404, detail=f"Unknown device service: {service}")


def _device_ip(device_id: str) -> str:
    device = registry.get(device_id)
    if not device:
        raise HTTPException(status_code=404, detail=f"Unknown device: {device_id}")
    return device["ip"]


@router.api_route(
    "/d/{device_id}/{service}/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def proxy_http(device_id: str, service: str, path: str, request: Request):
    ip = _device_ip(device_id)
    port = _service_port(service)

    url = httpx.URL(f"http://{ip}:{port}/{path}", query=request.url.query.encode())
    headers = {
        k: v for k, v in request.headers.items() if k.lower() not in _HOP_HEADERS
    }

    upstream_request = _proxy_client.build_request(
        request.method, url, headers=headers, content=await request.body()
    )

    try:
        upstream = await _proxy_client.send(upstream_request, stream=True)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Device unreachable: {e}")

    # Тело идёт байт в байт, поэтому Content-Length устройства верен и нужен клиенту
    response_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_HEADERS or k.lower() == "content-length"
    }
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers=response_headers,
        background=BackgroundTask(upstream.aclose),
    )


async def _bridge_websocket(websocket: WebSocket, device_id: str, port: int, path: str):
    device = registry.get(device_id)
    if not device:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    uri = f"ws://{device['ip']}:{port}/{path}"

    try:
        async with websockets.connect(uri) as upstream:

            async def client_to_upstream():
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
                    if "text" in message and message["text"] is not None:
                        await upstream.send(message["text"])
                    elif "bytes" in message and message["bytes"] is not None:
                        await upstream.send(message["bytes"])

            async def upstream_to_client():
                async for message in upstream:
                    if isinstance(message, str):
                        await websocket.send_text(message)
                    else:
                        await websocket.send_bytes(message)

            # Первый разорвавший сторону завершает мост целиком
            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(client_to_upstream()),
                    asyncio.create_task(upstream_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
    except (WebSocketDisconnect, websockets.exceptions.WebSocketException, OSError) as e:
        logger.debug(f"WS bridge to {uri} closed: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@router.websocket("/d/{device_id}/signaling/{path:path}")
async def proxy_signaling(websocket: WebSocket, device_id: str, path: str):
    await _bridge_websocket(websocket, device_id, settings.DEVICE_SIGNALING_PORT, path)


@router.websocket("/d/{device_id}/storage/{path:path}")
async def proxy_storage_ws(websocket: WebSocket, device_id: str, path: str):
    await _bridge_websocket(websocket, device_id, settings.DEVICE_STORAGE_PORT, path)
