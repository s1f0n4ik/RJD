import asyncio
import sqlite3
import time
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.config import settings
from app.export import run_export
from app.jobs import jobs
from app.master import journal, run

router = APIRouter(prefix="/api/journal", tags=["Journal"])

VERDICTS = {"unverified", "true", "false"}


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(journal.db_path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


def _now_ms() -> int:
    return int(time.time() * 1000)


# ── Фильтры: один набор для списка, счётчика, сводки и выгрузки ──

class Filters(BaseModel):
    t_from: Optional[int] = None
    t_to: Optional[int] = None
    verdict: Optional[str] = None
    device_id: Optional[str] = None
    camera_id: Optional[str] = None
    config_id: Optional[str] = None
    cids: Optional[list[int]] = None
    bbox: Optional[list[float]] = None


def _numbers(text: Optional[str], cast) -> Optional[list]:
    if not text:
        return None
    try:
        return [cast(part) for part in text.split(",") if part.strip()] or None
    except ValueError:
        raise HTTPException(status_code=400, detail=f"bad list: {text}")


def query_filters(
    t_from: Optional[int] = None,
    t_to: Optional[int] = None,
    verdict: Optional[str] = None,
    device_id: Optional[str] = None,
    camera_id: Optional[str] = None,
    config_id: Optional[str] = None,
    cids: Optional[str] = Query(None, description="id классов через запятую"),
    bbox: Optional[str] = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
) -> Filters:
    box = _numbers(bbox, float)
    if box is not None and len(box) != 4:
        raise HTTPException(status_code=400, detail="bbox must be min_lon,min_lat,max_lon,max_lat")
    return Filters(t_from=t_from, t_to=t_to, verdict=verdict, device_id=device_id, camera_id=camera_id,
                   config_id=config_id, cids=_numbers(cids, int), bbox=box)


def _where(f: Filters) -> tuple[str, list]:
    where, params = [], []
    for column, value in (("started_at >=", f.t_from), ("started_at <=", f.t_to), ("device_id =", f.device_id),
                          ("camera_id =", f.camera_id), ("config_id =", f.config_id)):
        if value is not None and value != "":
            where.append(f"d.{column} ?")
            params.append(value)
    if f.verdict in VERDICTS:
        where.append("d.verdict = ?")
        params.append(f.verdict)
    if f.cids:
        where.append(f"d.class_id IN ({','.join('?' for _ in f.cids)})")
        params.extend(f.cids)
    if f.bbox:
        where.append("d.gps_valid = 1 AND d.lon BETWEEN ? AND ? AND d.lat BETWEEN ? AND ?")
        params.extend([f.bbox[0], f.bbox[2], f.bbox[1], f.bbox[3]])
    return ("WHERE " + " AND ".join(where)) if where else "", params


# ── Обнаружения ──

def _preview(conn: sqlite3.Connection, detection_id: int, image_id: Optional[int]) -> Optional[dict]:
    if image_id is None:
        return None
    row = conn.execute(
        "SELECT e.x, e.y, e.w, e.h, e.frame_w, e.frame_h, e.confidence, e.ts, t.track_no FROM images i "
        "JOIN events e ON e.device_id = i.device_id AND e.session = i.session AND e.image_ref = i.device_image_id "
        "JOIN tracks t ON t.id = e.track_id WHERE i.id = ? AND t.detection_id = ? ORDER BY e.ts LIMIT 1",
        [image_id, detection_id],
    ).fetchone()
    if row is None:
        return {"image_id": image_id}
    return {
        "image_id": image_id,
        "box": [row["x"], row["y"], row["w"], row["h"]] if row["w"] is not None else None,
        "frame_w": row["frame_w"], "frame_h": row["frame_h"],
        "confidence": row["confidence"], "ts": row["ts"], "track_no": row["track_no"],
    }


def _gps(conn: sqlite3.Connection, row: sqlite3.Row) -> Optional[dict]:
    if not row["gps_valid"]:
        return None
    first = conn.execute(
        "SELECT e.alt, e.speed, e.course FROM events e JOIN tracks t ON t.id = e.track_id "
        "WHERE t.detection_id = ? AND e.gps_valid = 1 ORDER BY e.ts LIMIT 1",
        [row["id"]],
    ).fetchone()
    return {
        "lat": row["lat"], "lon": row["lon"],
        "alt": first["alt"] if first else None,
        "speed": first["speed"] if first else None,
        "course": first["course"] if first else None,
    }


def _item(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "device_id": row["device_id"],
        "camera_id": row["camera_id"],
        "config_id": row["config_id"],
        "class_id": row["class_id"],
        "class_name": row["class_name"],
        "superclass": row["superclass"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "closed_reason": row["closed_reason"],
        "late": bool(row["late"]),
        "tracks": row["tracks"],
        "images": row["images"],
        "preview": _preview(conn, row["id"], row["image_id"]),
        "gps": _gps(conn, row),
        "verdict": row["verdict"],
        "verdict_note": row["verdict_note"],
        "verdict_at": row["verdict_at"],
        "frame_url": f"/api/journal/frame/{row['id']}.jpg" if row["image_id"] is not None else None,
    }


SELECT_DETECTIONS = (
    "SELECT d.*, "
    "(SELECT COUNT(*) FROM tracks t WHERE t.detection_id = d.id) AS tracks, "
    "(SELECT COUNT(DISTINCT e.image_ref) FROM events e JOIN tracks t ON t.id = e.track_id "
    "WHERE t.detection_id = d.id AND e.image_ref IS NOT NULL) AS images "
    "FROM detections d "
)


@router.get("/head")
def head(f: Filters = Depends(query_filters)):
    """Максимальный id, число записей и открытых по фильтрам списка — для опроса изменений."""
    clause, params = _where(f)
    with closing(_db()) as conn:
        row = conn.execute(
            f"SELECT COALESCE(MAX(d.id), 0), COUNT(*), COALESCE(SUM(d.ended_at IS NULL), 0) FROM detections d {clause}",
            params,
        ).fetchone()
    return {"max_id": row[0], "total": row[1], "open": row[2]}


@router.get("/detections")
def list_detections(
    f: Filters = Depends(query_filters),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    order: str = Query("desc"),
):
    """Обнаружения по фильтрам, новые сверху."""
    clause, params = _where(f)
    direction = "ASC" if order == "asc" else "DESC"
    with closing(_db()) as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM detections d {clause}", params).fetchone()[0]
        rows = conn.execute(
            f"{SELECT_DETECTIONS}{clause} ORDER BY d.started_at {direction}, d.id {direction} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        items = [_item(conn, r) for r in rows]
    return {"detections": items, "total": total, "limit": limit, "offset": offset}


@router.get("/detections/{detection_id}")
def get_detection(detection_id: int):
    """Обнаружение с треками и всеми снимками."""
    with closing(_db()) as conn:
        row = conn.execute(f"{SELECT_DETECTIONS}WHERE d.id = ?", [detection_id]).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Detection not found")
        item = _item(conn, row)
        item["track_list"] = [
            dict(r) for r in conn.execute(
                "SELECT track_no, class_id, class_name, superclass, first_ts, last_ts FROM tracks "
                "WHERE detection_id = ? ORDER BY first_ts", [detection_id])
        ]
        item["image_list"] = [
            {
                "image_id": r["id"], "ts": r["ts"], "track_no": r["track_no"],
                "box": [r["x"], r["y"], r["w"], r["h"]] if r["w"] is not None else None,
                "frame_w": r["frame_w"], "frame_h": r["frame_h"], "confidence": r["confidence"],
                "url": f"/api/journal/image/{r['id']}.jpg",
            }
            for r in conn.execute(
                "SELECT i.id, MIN(e.ts) AS ts, t.track_no, e.x, e.y, e.w, e.h, e.frame_w, e.frame_h, e.confidence "
                "FROM events e JOIN tracks t ON t.id = e.track_id JOIN images i ON i.device_id = e.device_id "
                "AND i.session = e.session AND i.device_image_id = e.image_ref "
                "WHERE t.detection_id = ? GROUP BY i.id ORDER BY ts", [detection_id])
        ]
    return item


class VerdictRequest(BaseModel):
    verdict: str
    note: Optional[str] = None


@router.patch("/detections/{detection_id}/verdict")
async def set_verdict(detection_id: int, req: VerdictRequest):
    """Вердикт и заметка обнаружения."""
    if req.verdict not in VERDICTS:
        raise HTTPException(status_code=400, detail=f"verdict must be one of {sorted(VERDICTS)}")
    if not await run(journal.set_verdict, detection_id, req.verdict, req.note, _now_ms()):
        raise HTTPException(status_code=404, detail="Detection not found")
    return {"ok": True, "id": detection_id, "verdict": req.verdict}


# ── Кадры ──

def _frame_file(rel: Optional[str]) -> Path:
    if not rel:
        raise HTTPException(status_code=404, detail="Frame not found")
    path = journal.frames_dir / rel
    try:
        path.resolve().relative_to(journal.frames_dir.resolve())
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="Frame not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Frame not found")
    return path


@router.get("/frame/{detection_id}.jpg")
def get_frame(detection_id: int):
    """Превью обнаружения."""
    with closing(_db()) as conn:
        row = conn.execute(
            "SELECT i.path FROM detections d JOIN images i ON i.id = d.image_id WHERE d.id = ?", [detection_id]
        ).fetchone()
    return FileResponse(_frame_file(row[0] if row else None), media_type="image/jpeg")


@router.get("/image/{image_id}.jpg")
def get_image(image_id: int):
    """Снимок по id."""
    with closing(_db()) as conn:
        row = conn.execute("SELECT path FROM images WHERE id = ?", [image_id]).fetchone()
    return FileResponse(_frame_file(row[0] if row else None), media_type="image/jpeg")


# ── Сводка за период ──

@router.get("/summary")
def summary(f: Filters = Depends(query_filters)):
    """Числа по тем же фильтрам: вердикты, устройства, камеры, классы, часы, дни."""
    clause, params = _where(f)
    with closing(_db()) as conn:
        q = lambda sql: conn.execute(sql.format(where=clause), params).fetchall()
        total = q("SELECT COUNT(*) FROM detections d {where}")[0][0]
        verdicts = {v: 0 for v in VERDICTS}
        verdicts.update({r[0]: r[1] for r in q("SELECT d.verdict, COUNT(*) FROM detections d {where} GROUP BY 1")})
        devices = [{"device_id": r[0], "count": r[1]} for r in q(
            "SELECT d.device_id, COUNT(*) FROM detections d {where} GROUP BY 1 ORDER BY 2 DESC")]
        cameras = [
            {"device_id": r[0], "camera_id": r[1], "count": r[2], "true": r[3], "false": r[4], "unverified": r[5]}
            for r in q("SELECT d.device_id, d.camera_id, COUNT(*), SUM(d.verdict = 'true'), SUM(d.verdict = 'false'), "
                       "SUM(d.verdict = 'unverified') FROM detections d {where} GROUP BY 1, 2 ORDER BY 3 DESC")
        ]
        classes = [
            {"superclass": r[0], "class_id": r[1], "class_name": r[2], "count": r[3]}
            for r in q("SELECT d.superclass, d.class_id, d.class_name, COUNT(*) FROM detections d {where} "
                       "GROUP BY 1, 2, 3 ORDER BY 4 DESC")
        ]
        hours = [0] * 24
        for r in q("SELECT CAST((d.started_at / 3600000) % 24 AS INTEGER), COUNT(*) FROM detections d {where} GROUP BY 1"):
            hours[r[0]] = r[1]
        by_day = {r[0]: r[1] for r in q(
            "SELECT date(d.started_at / 1000, 'unixepoch'), COUNT(*) FROM detections d {where} GROUP BY 1")}
    days = []
    if by_day:
        day, last = date.fromisoformat(min(by_day)), date.fromisoformat(max(by_day))
        while day <= last:
            days.append({"day": day.isoformat(), "count": by_day.get(day.isoformat(), 0)})
            day += timedelta(days=1)
    return {"total": total, "verdicts": verdicts, "devices": devices, "cameras": cameras,
            "classes": classes, "hours": hours, "days": days}


# ── Хранилище: лимиты и очистка ──

class LimitsRequest(BaseModel):
    images_limit_gb: float
    db_limit_gb: float


class PurgeRequest(BaseModel):
    # unix мс; нет — все закрытые обнаружения
    before_ts: Optional[int] = None


@router.get("/settings")
async def get_settings():
    """Лимиты хранилища журнала и занятость."""
    return await run(journal.storage_state)


@router.post("/settings")
async def set_settings(req: LimitsRequest):
    if req.images_limit_gb < 0 or req.db_limit_gb < 0:
        raise HTTPException(status_code=400, detail="limits must be >= 0")
    await run(journal.write_limits, req.images_limit_gb, req.db_limit_gb)
    return await run(journal.storage_state)


@router.post("/purge")
async def purge(req: PurgeRequest):
    """Очистка журнала: закрытые обнаружения со снимками, все или старше даты."""
    result = await run(journal.purge, req.before_ts)
    return {**result, **(await run(journal.storage_state))}


# ── Выгрузка ──

class LegendEntry(BaseModel):
    name: str = ""
    color: str = ""


class ExportRequest(Filters):
    boxes: bool = True
    data: bool = True
    legend: dict[str, LegendEntry] = {}
    title: str = ""
    subtitle: str = ""


def _export_rows(f: Filters) -> list[dict]:
    clause, params = _where(f)
    with closing(_db()) as conn:
        rows = conn.execute(
            f"{SELECT_DETECTIONS}{clause} ORDER BY d.started_at ASC, d.id ASC", params).fetchall()
        out = []
        for r in rows:
            item = _item(conn, r)
            path = conn.execute("SELECT path FROM images WHERE id = ?", [r["image_id"]]).fetchone() if r["image_id"] else None
            item["frame"] = str(journal.frames_dir / path[0]) if path and path[0] else None
            out.append(item)
    return out


@router.post("/export")
async def export(req: ExportRequest):
    """Архив превью по фильтрам списка; ход — WS /api/journal/jobs/{id}/progress."""
    job = jobs.create(req.title, req.subtitle)
    legend = {cid: entry.model_dump() for cid, entry in req.legend.items()}
    asyncio.create_task(run_export(job, lambda: _export_rows(req), boxes=req.boxes, data=req.data, legend=legend))
    return {"job_id": job.id}


@router.get("/jobs")
def list_jobs():
    """Незавершённые выгрузки — для восстановления после перезагрузки страницы."""
    return {"jobs": jobs.active()}


@router.delete("/jobs/{job_id}")
def cancel_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in ("ready", "downloaded", "failed", "cancelled"):
        jobs.cleanup(job)
    else:
        jobs.cancel(job)
    return {"ok": True}


async def _forget(job_id: str) -> None:
    job = jobs.get(job_id)
    if job is None:
        return
    jobs.update(job, status="downloaded")
    asyncio.create_task(_cleanup_later(job_id))


# Архив удаляется не сразу: клиент дописывает его на диск
async def _cleanup_later(job_id: str) -> None:
    await asyncio.sleep(settings.DOWNLOAD_CLEANUP_DELAY_SEC)
    job = jobs.get(job_id)
    if job is not None:
        jobs.cleanup(job)


@router.get("/jobs/{job_id}/download")
def download_job(job_id: str, background_tasks: BackgroundTasks):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "ready" or job.result_path is None:
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job.status})")
    if not job.result_path.exists():
        raise HTTPException(status_code=410, detail="Result file expired")
    background_tasks.add_task(_forget, job_id)
    return FileResponse(job.result_path, media_type=job.result_media_type, filename=job.result_path.name)


@router.websocket("/jobs/{job_id}/progress")
async def job_progress(ws: WebSocket, job_id: str):
    await ws.accept()
    job = jobs.get(job_id)
    if job is None:
        await ws.send_json({"status": "failed", "error": "Job not found"})
        await ws.close()
        return
    queue = jobs.subscribe(job)
    try:
        while True:
            event = await queue.get()
            await ws.send_json(event)
            if event["status"] in ("ready", "failed", "cancelled"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        jobs.unsubscribe(job, queue)
        try:
            await ws.close()
        except Exception:
            pass


# ── Карта: офлайн-тайлы и стиль ──

def _map_asset(rel: str) -> Path:
    root = Path(settings.MAP_DIR)
    path = root / rel
    try:
        path.resolve().relative_to(root.resolve())
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="Not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return path


@router.get("/tiles/{z}/{x}/{y}.pbf")
def get_tile(z: int, x: int, y: int):
    """Векторный тайл из офлайн .mbtiles; y переворачивается из TMS."""
    tiles = Path(settings.TILES_MBTILES)
    if not tiles.exists():
        raise HTTPException(status_code=404, detail="Tile not found")
    with closing(sqlite3.connect(f"file:{tiles}?mode=ro", uri=True, timeout=2.0)) as conn:
        row = conn.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
            [z, x, (1 << z) - 1 - y],
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Tile not found")
    data = row[0]
    headers = {"Cache-Control": "public, max-age=604800"}
    if data[:2] == b"\x1f\x8b":
        headers["Content-Encoding"] = "gzip"
    return Response(content=data, media_type="application/x-protobuf", headers=headers)


@router.get("/map/style.json")
def get_style():
    """Стиль MapLibre."""
    return FileResponse(_map_asset("style.json"), media_type="application/json")


@router.get("/map/glyphs/{fontstack}/{rng}.pbf")
def get_glyphs(fontstack: str, rng: str):
    """Глифы шрифта для подписей карты."""
    return FileResponse(_map_asset(f"glyphs/{fontstack}/{rng}.pbf"), media_type="application/x-protobuf",
                        headers={"Cache-Control": "public, max-age=604800"})


@router.get("/map/sprite/{name}")
def get_sprite(name: str):
    """Спрайты стиля."""
    media = "application/json" if name.endswith(".json") else "image/png"
    return FileResponse(_map_asset(f"sprite/{name}"), media_type=media)
