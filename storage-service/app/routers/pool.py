import asyncio
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.volumes import pool

router = APIRouter()


class VolumePatch(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    high: float | None = None
    low: float | None = None


class VolumeOrder(BaseModel):
    ids: list[str]


async def _call(fn: Callable, *args):
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, fn, *args)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"Not found: {e.args[0] if e.args else ''}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/storage/pool")
async def storage_pool():
    """Тома пула устройства, цель записи и сводка ёмкости."""
    return await _call(pool.snapshot)


@router.patch("/storage/volumes/{volume_id}")
async def storage_update(volume_id: str, patch: VolumePatch):
    """Имя, включение и пороги тома."""
    await _call(pool.update, volume_id, patch.model_dump(exclude_none=True))
    return await _call(pool.snapshot)


@router.put("/storage/order")
async def storage_order(order: VolumeOrder):
    """Порядок записи на внешние тома."""
    await _call(pool.reorder, order.ids)
    return await _call(pool.snapshot)


@router.delete("/storage/volumes/{volume_id}")
async def storage_forget(volume_id: str):
    """Забыть извлечённый том: строки его сегментов уходят из индекса."""
    removed = await _call(pool.forget, volume_id)
    return {"removed": removed}


@router.get("/storage/volumes/{volume_id}/foreign")
async def storage_foreign(volume_id: str):
    """Архивы других устройств на подключённом томе."""
    return {"devices": await _call(pool.foreign, volume_id)}


@router.delete("/storage/volumes/{volume_id}/foreign/{device_id}")
async def storage_clear_foreign(volume_id: str, device_id: str):
    """Удалить архив другого устройства с тома."""
    await _call(pool.clear_foreign, volume_id, device_id)
    return {"ok": True}
