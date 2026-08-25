from fastapi import WebSocket, WebSocketDisconnect
from typing import Any, Dict, List
import asyncio
import logging

from app.config import settings

logger = logging.getLogger(__name__)


async def fetch_cameras() -> Dict[str, Any]:
    """
    Камеры со всех устройств реестра; offline-устройства — из кэша поллера.

    Возвращает пустой dict при любой ошибке — broadcast не должен падать
    из-за временной недоступности устройств.
    """
    from app.services.devices import registry

    cameras: Dict[str, Any] = {}
    for device in registry.snapshot():
        data: Dict[str, Any] = {}
        try:
            url = f"http://{device['ip']}:{settings.DEVICE_MC_PORT}/camera"
            response = await registry.client.get(url)
            response.raise_for_status()
            data = response.json().get("data") or {}
        except Exception:
            data = registry.cached_camera_data(device["id"])

        for camera_id, camera in (data.get("cameras") or {}).items():
            cameras[camera_id] = {
                **camera,
                "device_id": device["id"],
                "device_name": device["name"],
            }

    return cameras


def _build_state_payload(cameras: Dict[str, Any], message_type: str) -> Dict[str, Any]:
    """Собирает payload для отправки в WebSocket."""
    return {
        "type": message_type,
        "data": {
            "cameras": cameras,
            "summary": {
                "cameras_total": len(cameras),
                # Камера в работе, если работает хотя бы один её поток:
                # зашитого потока main больше нет, у камеры их произвольное число
                "cameras_running": sum(
                    1 for cam in cameras.values()
                    if any(
                        stream.get("status") == 3
                        for stream in (cam.get("streams") or {}).values()
                    )
                ),
            },
        },
    }


class ConnectionManager:
    """WebSocket ТОЛЬКО для уведомлений о статусе камер (НЕ для видео!)"""

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._update_task: asyncio.Task | None = None

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("✅ WebSocket connected. Total: %d", len(self.active_connections))

        await self.send_initial_state(websocket)

        if not self._update_task or self._update_task.done():
            self._update_task = asyncio.create_task(self.background_updater())

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info("❌ WebSocket disconnected. Total: %d", len(self.active_connections))

    async def send_initial_state(self, websocket: WebSocket):
        cameras = await fetch_cameras()
        await websocket.send_json(_build_state_payload(cameras, "initial_state"))

    async def broadcast_status_update(self):
        if not self.active_connections:
            return

        cameras = await fetch_cameras()
        message = _build_state_payload(cameras, "status_update")

        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)

        for conn in disconnected:
            self.disconnect(conn)

    async def background_updater(self):
        try:
            while self.active_connections:
                await asyncio.sleep(2)
                await self.broadcast_status_update()
        except asyncio.CancelledError:
            pass


manager = ConnectionManager()


async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)