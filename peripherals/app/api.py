from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.config import settings
from app.lifecycle import Lifecycle
from app.registry import Registry


def create_router(registry: Registry, lifecycle: Lifecycle) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": settings.APP_NAME, "version": settings.APP_VERSION}

    @router.get("/runtime")
    async def runtime() -> dict:
        return lifecycle.status()

    @router.put("/runtime")
    async def runtime_command(body: dict) -> dict:
        async with lifecycle.lock:
            try:
                if body.get("action") == "stop":
                    return await lifecycle.stop(body)
                if body.get("action") == "start":
                    return await lifecycle.start(body)
                raise ValueError("Unknown runtime action")
            except ValueError as error:
                raise HTTPException(409, str(error)) from error

    @router.put("/config")
    async def apply_config(body: dict) -> dict:
        async with lifecycle.lock:
            try:
                return await lifecycle.apply(body)
            except ValueError as error:
                raise HTTPException(409, str(error)) from error

    @router.get("/status")
    async def status() -> dict:
        return {
            "service": settings.APP_NAME,
            "runtime": lifecycle.status(),
            "gateway_time": registry.gateway_time.model_dump(mode="json"),
            "devices": [item.model_dump(mode="json") for item in registry.describe()],
        }

    @router.get("/devices")
    async def devices() -> list[dict]:
        return [item.model_dump(mode="json") for item in registry.describe()]

    @router.get("/values")
    async def values() -> list[dict]:
        return [item.model_dump(mode="json") for item in registry.values()]

    @router.websocket("/ws/scans/{device_id}")
    async def scans(websocket: WebSocket, device_id: str) -> None:
        await websocket.accept()
        try:
            for value in registry.values():
                if value.device_id == device_id and value.channel_id == "scan":
                    await websocket.send_json(value.model_dump(mode="json"))
            async for value in registry.subscribe_values():
                if value.device_id == device_id and value.channel_id == "scan":
                    await websocket.send_text(json.dumps(value.model_dump(mode="json"), ensure_ascii=False))
        except (WebSocketDisconnect, asyncio.CancelledError):
            return

    return router
