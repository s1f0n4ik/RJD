import asyncio
import json
import logging
from typing import Set, Dict, Any
from datetime import datetime
from fastapi import WebSocket, WebSocketDisconnect

from app.services import flask_client
from app.services.flask_client import FlaskClientError
from app.config import settings

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Менеджер WebSocket соединений"""

    def __init__(self):
        # Активные WebSocket соединения
        self.active_connections: Set[WebSocket] = set()

        # Флаг для остановки broadcast
        self._broadcast_task: asyncio.Task | None = None
        self._running = False

        # Кэш последнего состояния для оптимизации
        self._last_state: Dict[str, Any] = {}

        logger.info("WebSocket ConnectionManager initialized")

    async def connect(self, websocket: WebSocket):
        """Подключить нового клиента"""
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(f"Client connected. Total connections: {len(self.active_connections)}")

        # Отправляем текущее состояние новому клиенту
        if self._last_state:
            try:
                await websocket.send_json({
                    "type": "initial_state",
                    "data": self._last_state,
                    "timestamp": datetime.utcnow().isoformat()
                })
            except Exception as e:
                logger.error(f"Failed to send initial state: {e}")

    def disconnect(self, websocket: WebSocket):
        """Отключить клиента"""
        self.active_connections.discard(websocket)
        logger.info(f"Client disconnected. Total connections: {len(self.active_connections)}")

    async def send_personal_message(self, message: dict, websocket: WebSocket):
        """Отправить сообщение конкретному клиенту"""
        try:
            await websocket.send_json(message)
        except Exception as e:
            logger.error(f"Failed to send personal message: {e}")
            self.disconnect(websocket)

    async def broadcast(self, message: dict):
        """Отправить сообщение всем подключенным клиентам"""
        if not self.active_connections:
            return

        disconnected = set()

        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except WebSocketDisconnect:
                disconnected.add(connection)
                logger.warning("Client disconnected during broadcast")
            except Exception as e:
                disconnected.add(connection)
                logger.error(f"Error broadcasting to client: {e}")

        # Удаляем отключенные соединения
        for conn in disconnected:
            self.disconnect(conn)

    async def broadcast_status_update(self):
        """Получить статус из Flask и разослать всем клиентам"""
        try:
            # Получаем данные из Flask
            cameras = await flask_client.get_all_cameras()
            loaders = await flask_client.get_all_loaders()

            # Формируем сообщение
            status_data = {
                "cameras": cameras,
                "loaders": loaders,
                "summary": {
                    "cameras_total": len(cameras),
                    "cameras_running": sum(1 for c in cameras if c.get("status") == "running"),
                    "cameras_failed": sum(1 for c in cameras if c.get("status") == "failed"),
                    "loaders_total": len(loaders),
                    "loaders_running": sum(1 for l in loaders if l.get("status") == "running"),
                    "loaders_stopped": sum(1 for l in loaders if l.get("status") == "stopped"),
                }
            }

            # Проверяем, изменилось ли состояние
            if status_data != self._last_state:
                self._last_state = status_data

                message = {
                    "type": "status_update",
                    "data": status_data,
                    "timestamp": datetime.utcnow().isoformat()
                }

                await self.broadcast(message)
                logger.debug(f"Broadcasted status update to {len(self.active_connections)} clients")

        except FlaskClientError as e:
            logger.error(f"Failed to get status from Flask: {e}")

            # Отправляем сообщение об ошибке
            error_message = {
                "type": "error",
                "message": "Flask server unavailable",
                "timestamp": datetime.utcnow().isoformat()
            }
            await self.broadcast(error_message)

        except Exception as e:
            logger.error(f"Unexpected error in broadcast_status_update: {e}", exc_info=True)

    async def broadcast_loop(self):
        """Цикл периодической рассылки обновлений"""
        logger.info(f"Starting broadcast loop (interval: {settings.WS_BROADCAST_INTERVAL}s)")

        while self._running:
            try:
                await self.broadcast_status_update()
                await asyncio.sleep(settings.WS_BROADCAST_INTERVAL)

            except asyncio.CancelledError:
                logger.info("Broadcast loop cancelled")
                break
            except Exception as e:
                logger.error(f"Error in broadcast loop: {e}", exc_info=True)
                await asyncio.sleep(settings.WS_BROADCAST_INTERVAL)

    async def start_broadcast(self):
        """Запустить фоновую рассылку обновлений"""
        if self._running:
            logger.warning("Broadcast already running")
            return

        self._running = True
        self._broadcast_task = asyncio.create_task(self.broadcast_loop())
        logger.info("Broadcast task started")

    async def stop_broadcast(self):
        """Остановить фоновую рассылку"""
        if not self._running:
            return

        self._running = False

        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass

        logger.info("Broadcast task stopped")

    async def heartbeat_loop(self, websocket: WebSocket):
        """Отправка heartbeat для проверки соединения"""
        try:
            while websocket in self.active_connections:
                await websocket.send_json({
                    "type": "heartbeat",
                    "timestamp": datetime.utcnow().isoformat()
                })
                await asyncio.sleep(settings.WS_HEARTBEAT_INTERVAL)
        except WebSocketDisconnect:
            self.disconnect(websocket)
        except Exception as e:
            logger.error(f"Heartbeat error: {e}")
            self.disconnect(websocket)


# Глобальный экземпляр менеджера
manager = ConnectionManager()


# WebSocket endpoint handler
async def websocket_endpoint(websocket: WebSocket):
    """Обработчик WebSocket подключений"""
    await manager.connect(websocket)

    # Запускаем heartbeat в фоне
    heartbeat_task = asyncio.create_task(manager.heartbeat_loop(websocket))

    try:
        while True:
            # Принимаем сообщения от клиента
            data = await websocket.receive_text()

            try:
                message = json.loads(data)
                message_type = message.get("type")

                logger.debug(f"Received message from client: {message_type}")

                # Обработка команд от клиента
                if message_type == "ping":
                    await manager.send_personal_message({
                        "type": "pong",
                        "timestamp": datetime.utcnow().isoformat()
                    }, websocket)

                elif message_type == "request_status":
                    # Немедленно отправить текущий статус
                    await manager.broadcast_status_update()

                elif message_type == "subscribe":
                    # Клиент подписывается на обновления (уже подписан по умолчанию)
                    await manager.send_personal_message({
                        "type": "subscribed",
                        "message": "Successfully subscribed to updates",
                        "timestamp": datetime.utcnow().isoformat()
                    }, websocket)

                else:
                    logger.warning(f"Unknown message type: {message_type}")
                    await manager.send_personal_message({
                        "type": "error",
                        "message": f"Unknown message type: {message_type}",
                        "timestamp": datetime.utcnow().isoformat()
                    }, websocket)

            except json.JSONDecodeError:
                logger.error(f"Invalid JSON received: {data}")
                await manager.send_personal_message({
                    "type": "error",
                    "message": "Invalid JSON format",
                    "timestamp": datetime.utcnow().isoformat()
                }, websocket)

    except WebSocketDisconnect:
        logger.info("Client disconnected normally")
    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
    finally:
        # Останавливаем heartbeat
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass

        manager.disconnect(websocket)