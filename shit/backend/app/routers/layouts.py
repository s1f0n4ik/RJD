"""
app/routers/layouts.py

Хранение видеосеток (layouts) на устройстве в JSON-файле.
Маршруты:
  GET    /api/layouts          — список всех сеток
  POST   /api/layouts          — создать/обновить сетку (по name как ключу)
  DELETE /api/layouts/{name}   — удалить сетку по имени
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)

# Том настроек мастера: переживает пересборку контейнеров
LAYOUTS_FILE = Path(settings.LAYOUTS_FILE)


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
    timestamp: int


# ── Helpers ────────────────────────────────────────────────────

def _read_layouts() -> List[Dict]:
    """Читает layouts.json, возвращает список dict. Если файла нет — пустой список."""
    try:
        if LAYOUTS_FILE.exists():
            return json.loads(LAYOUTS_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error(f"layouts: read error: {e}")
    return []


def _write_layouts(layouts: List[Dict]) -> None:
    """Записывает список dict в layouts.json атомарно."""
    try:
        LAYOUTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = LAYOUTS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(layouts, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(LAYOUTS_FILE)
    except Exception as e:
        logger.error(f"layouts: write error: {e}")
        raise


# ── Endpoints ──────────────────────────────────────────────────

@router.get("/layouts", response_model=List[Layout])
async def get_layouts():
    """Вернуть все сохранённые сетки."""
    return _read_layouts()


@router.post("/layouts", response_model=Layout, status_code=status.HTTP_200_OK)
async def upsert_layout(layout: Layout):
    """
    Создать новую сетку или обновить существующую (ключ — name).
    Timestamp ставит клиент.
    """
    layouts = _read_layouts()

    idx = next((i for i, l in enumerate(layouts) if l.get("name") == layout.name), None)
    data = layout.dict()

    if idx is not None:
        layouts[idx] = data
    else:
        layouts.append(data)

    _write_layouts(layouts)
    return data


@router.delete("/layouts/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_layout(name: str):
    """Удалить сетку по имени."""
    layouts = _read_layouts()
    filtered = [l for l in layouts if l.get("name") != name]

    if len(filtered) == len(layouts):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Layout '{name}' not found",
        )

    _write_layouts(filtered)
    return None