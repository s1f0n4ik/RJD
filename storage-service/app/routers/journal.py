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
        t_from=t_from,
        t_to=t_to,
        verdict=verdict,
        camera_id=camera_id,
        config_id=config_id,
        cids=_parse_cids(cids),
        bbox=_parse_bbox(bbox),
        order=order,
        limit=limit,
        offset=offset,
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


@router.get("/journal/frame/{det_id}.jpg")
def get_frame(det_id: int):
    path = journal.resolve_frame(det_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Frame not found")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/journal/tiles/{z}/{x}/{y}.png")
def get_tile(z: int, x: int, y: int):
    data = journal.tile(z, x, y)
    if data is None:
        raise HTTPException(status_code=404, detail="Tile not found")
    return Response(content=data, media_type="image/png")
