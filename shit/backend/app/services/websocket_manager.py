from fastapi import WebSocket, WebSocketDisconnect
from typing import Any, Dict, List, Optional
import asyncio
import json
import logging
import time

from app.config import settings

logger = logging.getLogger(__name__)

# Сводки шлюза, нейронки и 360 ходят на платы реже камер
SLOW_INTERVAL_S = 10.0
SUMMARY_TIMEOUT_S = 3.0


async def _device_cameras(device: dict) -> tuple[dict, dict]:
    """Камеры устройства: живой ответ или кэш поллера с пометкой offline."""
    from app.services.devices import registry

    try:
        url = f"http://{device['ip']}:{settings.DEVICE_MC_PORT}/camera"
        response = await registry.client.get(url)
        response.raise_for_status()
        return device, {"data": response.json().get("data") or {}, "offline": False}
    except Exception:
        # Одиночный сбой при живом устройстве не гасит камеры: поллер ещё считает его в сети
        return device, {
            "data": registry.cached_camera_data(device["id"]),
            "offline": device["status"] != "online",
        }


async def fetch_cameras() -> Dict[str, Any]:
    """
    Камеры со всех устройств реестра; у не ответивших устройств — из кэша поллера.

    Возвращает пустой dict при любой ошибке — broadcast не должен падать
    из-за временной недоступности устройств.
    """
    from app.services.devices import registry

    results = await asyncio.gather(*(_device_cameras(d) for d in registry.snapshot()))

    cameras: Dict[str, Any] = {}
    for device, found in results:
        for camera_id, camera in (found["data"].get("cameras") or {}).items():
            # При совпадении id остаётся камера устройства, которое раньше в реестре
            if camera_id in cameras:
                continue
            cameras[camera_id] = {
                **camera,
                "device_id": device["id"],
                "device_name": device["name"],
                **({"offline": True} if found["offline"] else {}),
            }

    return cameras


async def _neural_summary() -> Optional[dict]:
    from app.routers.devices import aggregate_neural_summary

    try:
        return (await aggregate_neural_summary())["data"]
    except Exception as e:
        logger.debug(f"Neural summary failed: {e}")
        return None


async def _gateway_summary() -> Optional[dict]:
    from app.services.devices import registry

    try:
        response = await registry.client.get(
            f"{settings.GATEWAY_URL.rstrip('/')}/status", timeout=SUMMARY_TIMEOUT_S
        )
        response.raise_for_status()
        modules = response.json().get("modules") or []
        return {
            "modules": len(modules),
            "connected": sum(1 for m in modules if (m.get("connection") or {}).get("connected")),
        }
    except Exception as e:
        logger.debug(f"Gateway summary failed: {e}")
        return None


async def _linker_summary() -> Optional[dict]:
    from app.services.devices import registry

    device = registry.device_for_module("birdview")
    if not device:
        return None
    try:
        response = await registry.client.get(
            f"http://{device['ip']}:{settings.DEVICE_MC_PORT}/linker/status", timeout=SUMMARY_TIMEOUT_S
        )
        response.raise_for_status()
        body = response.json()
        data = body.get("data", body)
        return {
            "running": bool(data.get("running")),
            "view_mode": data.get("view_mode") or "top",
            "dual_output": bool(data.get("dual_output")),
        }
    except Exception as e:
        logger.debug(f"Linker summary failed: {e}")
        return None


def _build_state_payload(state: Dict[str, Any], message_type: str) -> Dict[str, Any]:
    """Собирает payload для отправки в WebSocket."""
    cameras = state["cameras"]
    return {
        "type": message_type,
        "ts": time.time(),
        "data": {
            **state,
            "summary": {
                "cameras_total": len(cameras),
                # Камера в работе, если работает хотя бы один её поток:
                # зашитого потока main больше нет, у камеры их произвольное число
                "cameras_running": sum(
                    1 for cam in cameras.values()
                    if not cam.get("offline") and any(
                        stream.get("status") == 3
                        for stream in (cam.get("streams") or {}).values()
                    )
                ),
            },
        },
    }


class ConnectionManager:
    """WebSocket ТОЛЬКО для состояния системы (камеры, устройства, сводки), НЕ для видео!"""

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._update_task: asyncio.Task | None = None
        self._slow: Dict[str, Any] = {"neural": None, "gateway": None, "linker": None}
        self._slow_at = 0.0
        # Отпечаток последнего разосланного состояния: без изменений шлётся только пульс
        self._last_digest = ""

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

    async def collect_state(self) -> Dict[str, Any]:
        from app.services.devices import registry

        if time.monotonic() - self._slow_at >= SLOW_INTERVAL_S:
            cameras, neural, gateway, linker = await asyncio.gather(
                fetch_cameras(), _neural_summary(), _gateway_summary(), _linker_summary()
            )
            self._slow = {"neural": neural, "gateway": gateway, "linker": linker}
            self._slow_at = time.monotonic()
        else:
            cameras = await fetch_cameras()

        return {
            "cameras": cameras,
            "devices": registry.snapshot(),
            "routing": registry.get_routing(),
            **self._slow,
        }

    async def send_initial_state(self, websocket: WebSocket):
        state = await self.collect_state()
        await websocket.send_json(_build_state_payload(state, "initial_state"))

    async def broadcast_status_update(self):
        if not self.active_connections:
            return

        state = await self.collect_state()
        digest = json.dumps(state, sort_keys=True, default=str)
        if digest != self._last_digest:
            self._last_digest = digest
            message = _build_state_payload(state, "status_update")
        else:
            message = {"type": "pulse", "ts": time.time()}

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
                try:
                    await self.broadcast_status_update()
                except Exception:
                    logger.exception("Status broadcast failed")
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
