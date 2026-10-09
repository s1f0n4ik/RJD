import asyncio
import json
import logging
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from app.config import settings
from app.jobs import Job, jobs
from app.overlay import ACC, Box, render

logger = logging.getLogger(__name__)

# Кадров за заход: между заходами обновляется прогресс и проверяется отмена
CHUNK = 20

_SAFE = re.compile(r"[^A-Za-z0-9_-]+")


# Время в журнале уже настенное: форматируется как UTC
def _stamp(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _entry_name(row: dict) -> str:
    camera = _SAFE.sub("_", row["camera_id"] or "cam").strip("_") or "cam"
    return f"{_stamp(row['started_at'])}_{camera}_{row['id']}.jpg"


def _draw(row: dict, *, boxes: bool, data: bool, legend: dict) -> bytes:
    drawn = []
    preview = row.get("preview")
    if boxes and preview and preview.get("box"):
        meta = legend.get(str(row["class_id"])) or {}
        name = meta.get("name") or row["class_name"] or f"cid {row['class_id']}"
        drawn.append(Box(*preview["box"], f"{name} {preview.get('confidence') or 0:.2f}", meta.get("color") or ACC))
    gps = row.get("gps")
    return render(Path(row["frame"]), drawn, row["started_at"] if data else None, (gps["lat"], gps["lon"]) if gps else None)


def _pack(zf: zipfile.ZipFile, rows: list[dict], *, boxes: bool, data: bool, legend: dict) -> int:
    written = 0
    for row in rows:
        try:
            if boxes or data:
                zf.writestr(_entry_name(row), _draw(row, boxes=boxes, data=data, legend=legend))
            else:
                zf.write(row["frame"], _entry_name(row))
        except FileNotFoundError:
            row["frame"] = None
            continue
        written += 1
    return written


def _sidecar(rows: list[dict]) -> bytes:
    items = []
    for row in rows:
        item = {k: v for k, v in row.items() if k not in ("frame", "frame_url")}
        item["file"] = _entry_name(row) if row["frame"] is not None else None
        items.append(item)
    return json.dumps({"detections": items}, ensure_ascii=False, indent=1).encode("utf-8")


# Существующие кадры: исчезнувшие помечаются отсутствующими
def _weigh(rows: list[dict]) -> int:
    total = 0
    for row in rows:
        if row["frame"] is None:
            continue
        try:
            total += Path(row["frame"]).stat().st_size
        except OSError:
            row["frame"] = None
    return total


async def run_export(job: Job, load_rows: Callable[[], list[dict]], *, boxes: bool, data: bool, legend: dict) -> None:
    try:
        jobs.update(job, status="queued", message="Ждёт своей очереди")
        async with jobs.lock:
            if not job.cancelled:
                await _export(job, load_rows, boxes, data, legend)
    except Exception as e:
        logger.exception("journal export %s failed", job.id)
        jobs.update(job, status="failed", error=str(e), message=f"Ошибка: {e}")
        jobs.cleanup(job)


async def _export(job: Job, load_rows: Callable[[], list[dict]], boxes: bool, data: bool, legend: dict) -> None:
    loop = asyncio.get_running_loop()
    jobs.update(job, status="parsing", progress=0.0, message="Подбираем записи")
    rows = await loop.run_in_executor(None, load_rows)
    if not rows:
        raise RuntimeError("No detections match the filters")

    need = await loop.run_in_executor(None, _weigh, rows)
    exports = Path(settings.EXPORTS_DIR)
    exports.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(exports).free
    if free < need * 1.2 + 64 * 1024 * 1024:
        raise RuntimeError(f"Not enough disk space for the export: need {need >> 20} MB, free {free >> 20} MB")

    present = [r for r in rows if r["frame"] is not None]
    job.work_dir = exports / job.id
    job.work_dir.mkdir(parents=True, exist_ok=True)
    output = job.work_dir / f"journal_{_stamp(rows[0]['started_at'])}_{_stamp(rows[-1]['started_at'])}.zip"
    jobs.update(job, files_total=len(present), bytes_total=need, result_path=output)

    done = 0
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as zf:
        for start in range(0, len(present), CHUNK):
            if job.cancelled:
                return
            chunk = present[start:start + CHUNK]
            jobs.update(job, status="archiving", progress=done / max(1, len(present)),
                        message=f"Кадр {start + 1} из {len(present)}")
            done += await loop.run_in_executor(
                None, lambda c=chunk: _pack(zf, c, boxes=boxes, data=data, legend=legend))
            jobs.update(job, files_processed=done)
        zf.writestr("detections.json", _sidecar(rows))

    if job.cancelled:
        return
    missing = len(rows) - done
    message = f"Собрано кадров: {done}" + (f", уже удалены: {missing}" if missing else "")
    logger.info("journal export %s: %d frames, %d missing", job.id, done, missing)
    jobs.update(job, status="ready", progress=1.0, message=message)
