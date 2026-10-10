"""
app/routers/configurations.py

Конфигурации изделия (РСМ-2000, Искра): выбор переключает модули шлюза АС КРСПС,
мастер обнаружений следует за шлюзом и берёт правила той же конфигурации.

Маршруты:
  GET  /api/configurations         — конфигурации шлюза, состояние модулей активной, правила мастера
  POST /api/configurations/select  — сделать конфигурацию активной: {"id": "rsm-2000"}
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


async def _get(client: httpx.AsyncClient, url: str) -> Optional[dict]:
    try:
        response = await client.get(url)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"configurations: {url} unavailable: {e}")
        return None


def _module(summary: dict, live: Optional[dict]) -> dict:
    out = {"id": summary.get("id"), "title": summary.get("title"), "transport": summary.get("transport")}
    if live is not None:
        connection = live.get("connection") or {}
        out.update(connected=bool(connection.get("connected")), url=connection.get("url") or "", error=connection.get("error") or "")
    return out


@router.get("/configurations")
async def list_configurations() -> dict:
    gateway = settings.GATEWAY_URL.rstrip("/")
    async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
        integrations, gw_status, rules = await asyncio.gather(
            _get(client, f"{gateway}/integrations"),
            _get(client, f"{gateway}/status"),
            _get(client, f"{settings.DETECTION_URL.rstrip('/')}/rules"),
        )

    active = (integrations or {}).get("active") or ""
    live = {m.get("id"): m for m in (gw_status or {}).get("modules", [])} if gw_status and gw_status.get("id") == active else {}
    items = [
        {
            "id": item.get("id"),
            "title": item.get("title"),
            "description": item.get("description"),
            "active": item.get("id") == active,
            "modules": [_module(m, live.get(m.get("id")) if item.get("id") == active else None) for m in item.get("modules", [])],
        }
        for item in (integrations or {}).get("items", [])
    ]
    return {"gateway": integrations is not None, "active": active, "items": items, "master": rules}


class SelectRequest(BaseModel):
    id: str


@router.post("/configurations/select")
async def select_configuration(req: SelectRequest) -> dict:
    url = f"{settings.GATEWAY_URL.rstrip('/')}/integrations/select"
    try:
        async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
            response = await client.post(url, json={"id": req.id})
    except httpx.HTTPError as e:
        logger.warning(f"configurations: gateway {url} unavailable: {e}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Gateway is unavailable")
    if response.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown configuration: {req.id}")
    if response.is_error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Gateway refused: {response.text[:200]}")
    logger.info(f"configuration {req.id} selected")
    return await list_configurations()
