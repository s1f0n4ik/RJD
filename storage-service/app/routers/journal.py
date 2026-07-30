import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.services.journal import journal, VERDICTS

logger = logging.getLogger(__name__)
router = APIRouter()


class VerdictRequest(BaseModel):
    verdict: str
    note: Optional[str] = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_cids(cids: Optional[str]) -> Optional[list[int]]:
    if not cids:
        return None
    out: list[int] = []
    for part in cids.split(","):
        part = part.strip()
        if part:
            try:
                out.append(int(part))
            except ValueError:
                continue
    return out or None


def _parse_bbox(bbox: Optional[str]) -> Optional[tuple[float, float, float, float]]:
    if not bbox:
        return None
    parts = bbox.split(",")
    if len(parts) != 4:
        raise HTTPException(status_code=400, detail="bbox must be min_lon,min_lat,max_lon,max_lat")
    try:
        min_lon, min_lat, max_lon, max_lat = (float(p) for p in parts)
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox values must be numbers")
    return (min_lon, min_lat, max_lon, max_lat)


def _filters(
    t_from: Optional[int],
    t_to: Optional[int],
    verdict: Optional[str],
    camera_id: Optional[str],
    config_id: Optional[str],
    cids: Optional[str],
    bbox: Optional[str],
) -> dict:
    return {
        "t_from": t_from,
        "t_to": t_to,
        "verdict": verdict,
        "camera_id": camera_id,
        "config_id": config_id,
        "cids": _parse_cids(cids),
        "bbox": _parse_bbox(bbox),
    }


@router.get("/journal/head")
def head(
    t_from: Optional[int] = Query(None, description="unix ms, начало диапазона"),
    t_to: Optional[int] = Query(None, description="unix ms, конец диапазона"),
    verdict: Optional[str] = Query(None, description="unverified | true | false"),
    camera_id: Optional[str] = None,
    config_id: Optional[str] = None,
    cids: Optional[str] = Query(None, description="id классов через запятую"),
    bbox: Optional[str] = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
):
    """Лёгкая ручка для периодического опроса: {max_id, total} по тем же
    фильтрам, что и список. Фронт перезапрашивает список только при изменении."""
    return journal.head(**_filters(t_from, t_to, verdict, camera_id, config_id, cids, bbox))


@router.get("/journal/detections")
def list_detections(
    t_from: Optional[int] = Query(None, description="unix ms, начало диапазона"),
    t_to: Optional[int] = Query(None, description="unix ms, конец диапазона"),
    verdict: Optional[str] = Query(None, description="unverified | true | false"),
    camera_id: Optional[str] = None,
    config_id: Optional[str] = None,
    cids: Optional[str] = Query(None, description="id классов через запятую"),
    bbox: Optional[str] = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return journal.list_detections(
        order=order,
        limit=limit,
        offset=offset,
        **_filters(t_from, t_to, verdict, camera_id, config_id, cids, bbox),
    )


@router.get("/journal/detections/{det_id}")
def get_detection(det_id: int):
    row = journal.get_detection(det_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Detection not found")
    return row


@router.patch("/journal/detections/{det_id}/verdict")
def set_verdict(det_id: int, req: VerdictRequest):
    if req.verdict not in VERDICTS:
        raise HTTPException(status_code=400, detail=f"verdict must be one of {sorted(VERDICTS)}")
    ok = journal.set_verdict(det_id, req.verdict, req.note, _now_ms())
    if not ok:
        raise HTTPException(status_code=404, detail="Detection not found")
    return {"ok": True, "id": det_id, "verdict": req.verdict}


class StorageSettingsRequest(BaseModel):
    images_limit_gb: float
    db_limit_gb: float


class PurgeRequest(BaseModel):
    # unix ms; None — удалить всё
    before_ts: Optional[int] = None


@router.get("/journal/settings")
def get_storage_settings():
    """Лимиты хранилища журнала и фактическая занятость."""
    return journal.storage_state()


@router.post("/journal/settings")
def set_storage_settings(req: StorageSettingsRequest):
    if req.images_limit_gb < 0 or req.db_limit_gb < 0:
        raise HTTPException(status_code=400, detail="limits must be >= 0")
    if not journal.write_limits(req.images_limit_gb, req.db_limit_gb):
        raise HTTPException(status_code=503, detail="Journal database is not available")
    return journal.storage_state()


@router.post("/journal/purge")
def purge(req: PurgeRequest):
    """Очистка журнала: записи вместе с изображениями, всё или старше даты."""
    if not journal.available():
        raise HTTPException(status_code=503, detail="Journal database is not available")
    result = journal.purge(req.before_ts)
    return {**result, **journal.storage_state()}


@router.get("/journal/frame/{det_id}.jpg")
def get_frame(det_id: int):
    path = journal.resolve_frame(det_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Frame not found")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/journal/tiles/{z}/{x}/{y}.pbf")
def get_tile(z: int, x: int, y: int):
    """Векторный тайл (схема OpenMapTiles) из offline .mbtiles."""
    data = journal.tile(z, x, y)
    if data is None:
        # Пустых тайлов в .mbtiles просто нет — для MapLibre это нормально.
        raise HTTPException(status_code=404, detail="Tile not found")

    headers = {"Cache-Control": "public, max-age=604800"}
    # В .mbtiles PBF обычно лежит уже gzip-сжатым: отдаём как есть, сообщив
    # браузеру кодировку по сигнатуре gzip (0x1f 0x8b).
    if data[:2] == b"\x1f\x8b":
        headers["Content-Encoding"] = "gzip"
    return Response(content=data, media_type="application/x-protobuf", headers=headers)


@router.get("/journal/map/style.json")
def get_style():
    """Стиль MapLibre. Лежит на томе рядом с глифами и спрайтами."""
    path = journal.resolve_map_asset("style.json")
    if path is None:
        raise HTTPException(status_code=404, detail="Style not found")
    return FileResponse(path, media_type="application/json")


@router.get("/journal/map/glyphs/{fontstack}/{rng}.pbf")
def get_glyphs(fontstack: str, rng: str):
    """Диапазон глифов шрифта — без них MapLibre не нарисует подписи."""
    path = journal.resolve_map_asset(f"glyphs/{fontstack}/{rng}.pbf")
    if path is None:
        raise HTTPException(status_code=404, detail="Glyphs not found")
    return FileResponse(
        path,
        media_type="application/x-protobuf",
        headers={"Cache-Control": "public, max-age=604800"},
    )


@router.get("/journal/map/sprite/{name}")
def get_sprite(name: str):
    """Спрайты стиля (sprite.json / sprite.png / @2x-варианты)."""
    path = journal.resolve_map_asset(f"sprite/{name}")
    if path is None:
        raise HTTPException(status_code=404, detail="Sprite not found")
    media = "application/json" if name.endswith(".json") else "image/png"
    return FileResponse(path, media_type=media)
