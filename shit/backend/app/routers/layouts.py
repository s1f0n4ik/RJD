# Сохранённые раскладки активного профиля и паспорта машины.

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel

from app.services.config_store import ConfigError, get_store

router = APIRouter()


# ── Pydantic-модели ────────────────────────────────────────────

class CustomCell(BaseModel):
    id: str
    row: int
    col: int
    rowSpan: int
    colSpan: int


class Layout(BaseModel):
    name: str
    gridSize: Any                          # 1 | 4 | 9 | 16 | "custom" | "single"
    customCells: List[CustomCell] | None = None
    customGridRows: int | None = None
    customGridCols: int | None = None
    activeCells: Dict[str, str]            # { cellId: cameraId }
    # Состояние вывода 360: { viewMode: "top"|"surround", manual: bool }
    surround: Dict[str, Any] | None = None
    # Камеры birdview с включённой коррекцией дисторсии: { cameraId: true }
    corrections: Dict[str, bool] | None = None
    # Показываемый поток камеры: { cameraId: "stream_2" }
    streams: Dict[str, str] | None = None
    # Рамки обнаружений поверх кадра: { cameraId: true }
    detections: Dict[str, bool] | None = None
    # Наложения на всё отображение: { name, time, detections }
    overlays: Dict[str, bool] | None = None
    timestamp: int


# ── Helpers ────────────────────────────────────────────────────

def _context() -> tuple[str, str, str]:
    store = get_store()
    profile = store.active_profile() or ""
    transition = store.profile_transition() or {}
    return profile, store.context(), transition.get("phase", "complete")


def _check_context(context: str | None) -> str:
    profile, current, _ = _context()
    if not profile:
        raise HTTPException(409, "No active machine profile")
    if context is not None and context != current:
        raise HTTPException(409, "Machine profile changed; reload layouts before saving")
    return profile


# ── Endpoints ──────────────────────────────────────────────────

@router.get("/layouts", response_model=List[Layout])
async def get_layouts(response: Response):
    profile, context, phase = _context()
    response.headers["X-Profile-Id"] = profile
    response.headers["X-Layout-Context"] = context
    response.headers["X-Profile-Phase"] = phase
    entities = get_store().effective(profile or None)["entities"].get("layout", {})
    return [entry["body"] for _, entry in sorted(entities.items())]


@router.post("/layouts", response_model=Layout, status_code=status.HTTP_200_OK)
async def upsert_layout(layout: Layout, context: str | None = Query(None)):
    """
    Создать новую сетку или обновить существующую (ключ — name).
    Timestamp ставит клиент.
    """
    data = layout.dict()
    try:
        with get_store().transaction():
            get_store().put(_check_context(context), "layout", layout.name, data)
    except ConfigError as error:
        raise HTTPException(409, str(error))
    return data


@router.delete("/layouts/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_layout(name: str, context: str | None = Query(None)):
    """Удалить сетку по имени."""
    try:
        with get_store().transaction():
            profile = _check_context(context)
            if name not in get_store().effective(profile)["entities"].get("layout", {}):
                raise HTTPException(404, f"Layout '{name}' not found")
            get_store().remove(profile, "layout", name)
    except ConfigError as error:
        raise HTTPException(409, str(error))
    return None
