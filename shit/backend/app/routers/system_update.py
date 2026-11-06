from __future__ import annotations

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from app.services import system_update
from app.services.auth import require_admin

router = APIRouter()
logger = logging.getLogger(__name__)
admin = [Depends(require_admin)]


class StartUpdate(BaseModel):
    confirm: bool = False


def _reply(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        body = {"error": response.text[:300]}
    if response.status_code >= 400:
        raise HTTPException(response.status_code, body.get("error") or "Update service error")
    return body


async def _call(method: str, path: str, **kwargs) -> dict:
    try:
        response = await system_update.client().request(method, path, **kwargs)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Update service does not answer: {e}") from None
    return _reply(response)


@router.get("/update/lock")
async def update_lock():
    """Идёт ли обновление и в какой фазе: для плашки в верхней панели."""
    return await system_update.lock_state()


@router.get("/update/state", dependencies=admin)
async def update_state():
    """Платы, версии, загруженный файл, проверки перед запуском и ход обновления."""
    return await _call("GET", "/state", timeout=httpx.Timeout(30, connect=2))


@router.put("/update/file", dependencies=admin)
async def upload_file(request: Request):
    """Файл обновления: тело идёт потоком в службу обновления и в памяти не держится."""
    length = request.headers.get("content-length")
    if not length:
        raise HTTPException(411, "Content-Length is required")
    headers = {"Content-Length": length, "Content-Type": "application/octet-stream",
               "X-File-Name": request.headers.get("x-file-name", "")}
    return await _call("PUT", "/file", content=request.stream(), headers=headers, timeout=httpx.Timeout(900, connect=2))


@router.delete("/update/file", dependencies=admin)
async def remove_file():
    return await _call("DELETE", "/file")


@router.post("/update/start", dependencies=admin)
async def start_update(body: StartUpdate):
    return await _call("POST", "/start", json=body.model_dump(), timeout=httpx.Timeout(30, connect=2))


@router.post("/update/cancel", dependencies=admin)
async def cancel_update():
    return await _call("POST", "/cancel", json={})


@router.post("/update/revert", dependencies=admin)
async def revert_update():
    """Вернуть предыдущую версию: файл не нужен, прежняя версия хранится на платах."""
    return await _call("POST", "/revert", json={}, timeout=httpx.Timeout(30, connect=2))


@router.get("/update/board-log", dependencies=admin)
async def board_log(id: Optional[str] = Query(None)):
    return await _call("GET", "/board-log", params={"id": id or ""})
