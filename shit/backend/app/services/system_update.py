from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_client: Optional[httpx.AsyncClient] = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=settings.UPDATE_MASTER_URL, timeout=httpx.Timeout(15, connect=2))
    return _client


async def lock_state() -> dict:
    # Служба обновления не установлена или не отвечает: обновление не идёт, записи не блокируются
    try:
        response = await client().get("/lock", timeout=httpx.Timeout(2, connect=1))
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError):
        return {"busy": False, "phase": None, "kind": None}
