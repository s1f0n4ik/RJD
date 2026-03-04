from fastapi import WebSocket, WebSocketDisconnect
from typing import List
import asyncio
import logging
from app.services.cpp_client import cpp_client

logger = logging.getLogger(__name__)


class ConnectionManager:
    """WebSocket ТОЛЬКО для уведомлений о статусе камер (НЕ для видео!)"""

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._update_task = None

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"✅ WebSocket connected. Total: {len(self.active_connections)}")

        # Отправляем начальное состояние
        await self.send_initial_state(websocket)

        # Запускаем фоновое обновление
        if not self._update_task or self._update_task.done():
            self._update_task = asyncio.create_task(self.background_updater())

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"❌ WebSocket disconnected. Total: {len(self.active_connections)}")

    async def send_initial_state(self, websocket: WebSocket):
        """Отправить начальное состояние"""
        cameras = await cpp_client.get_cameras()

        await websocket.send_json({
            "type": "initial_state",
            "data": {
                "cameras": cameras,
                "summary": {
                    "cameras_total": len(cameras),
                    "cameras_running": sum(
                        1 for cam in cameras.values()
                        if cam.get("streams", {}).get("main", {}).get("status") == 3
                    )
                }
            }
        })

    async def broadcast_status_update(self):
        """Рассылка обновлений статусов"""
        if not self.active_connections:
            return

        cameras = await cpp_client.get_cameras()

        message = {
            "type": "status_update",
            "data": {
                "cameras": cameras,
                "summary": {
                    "cameras_total": len(cameras),
                    "cameras_running": sum(
                        1 for cam in cameras.values()
                        if cam.get("streams", {}).get("main", {}).get("status") == 3
                    )
                }
            }
        }

        # Отправляем всем
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except:
                disconnected.append(connection)

        # Удаляем отключившихся
        for conn in disconnected:
            self.disconnect(conn)

    async def background_updater(self):
        """Фоновая задача"""
        try:
            while self.active_connections:
                await asyncio.sleep(2)
                await self.broadcast_status_update()
        except asyncio.CancelledError:
            pass


manager = ConnectionManager()


async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint для уведомлений о статусе"""
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # Просто держим соединение
    except WebSocketDisconnect:
        manager.disconnect(websocket)