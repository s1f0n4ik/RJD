from fastapi import WebSocket
from typing import List
import asyncio
from app.services.cpp_client import cpp_client


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._update_task = None

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

        # Отправляем начальное состояние
        await self.send_initial_state(websocket)

        # Запускаем фоновое обновление, если еще не запущено
        if not self._update_task:
            self._update_task = asyncio.create_task(self.background_updater())

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def send_initial_state(self, websocket: WebSocket):
        """Отправить начальное состояние"""
        cameras = await cpp_client.get_cameras()

        await websocket.send_json({
            "type": "initial_state",
            "data": {
                "cameras": [c.dict() for c in cameras],
                "summary": {
                    "cameras_total": len(cameras),
                    "cameras_running": sum(1 for c in cameras if c.main.status == 3)
                }
            }
        })

    async def broadcast_status_update(self):
        """Рассылка обновлений всем клиентам"""
        if not self.active_connections:
            return

        cameras = await cpp_client.get_cameras()

        message = {
            "type": "status_update",
            "data": {
                "cameras": [c.dict() for c in cameras],
                "summary": {
                    "cameras_total": len(cameras),
                    "cameras_running": sum(1 for c in cameras if c.main.status == 3)
                }
            }
        }

        # Отправляем всем подключенным клиентам
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except:
                disconnected.append(connection)

        # Удаляем отключившихся
        for conn in disconnected:
            self.active_connections.remove(conn)

    async def background_updater(self):
        """Фоновая задача для периодического обновления"""
        while True:
            await asyncio.sleep(2)  # Обновление каждые 2 секунды
            await self.broadcast_status_update()


manager = ConnectionManager()