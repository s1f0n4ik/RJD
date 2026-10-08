import asyncio
import io
import json
import logging
import re
import shutil
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw, ImageFont

from app.config import settings
from app.jobs import Job, jobs

logger = logging.getLogger(__name__)

FONT_PATH = Path(__file__).resolve().parents[1] / "fonts" / "PTSans-Regular.ttf"
DEFAULT_COLOR = "#5b9dff"
LABEL_TEXT = "#08101f"
PLATE_TEXT = "#ffffff"
JPEG_QUALITY = 90
# Кадров за заход: между заходами обновляется прогресс и проверяется отмена
CHUNK = 20

_SAFE = re.compile(r"[^A-Za-z0-9_-]+")


@lru_cache(maxsize=8)
def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_PATH), size)


# Время в журнале уже настенное: форматируется как UTC
def _stamp(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _wall(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%d.%m.%Y %H:%M:%S")


def _entry_name(row: dict) -> str:
    camera = _SAFE.sub("_", row["camera_id"] or "cam").strip("_") or "cam"
    return f"{_stamp(row['started_at'])}_{camera}_{row['id']}.jpg"


def _draw(row: dict, *, boxes: bool, data: bool, legend: dict) -> bytes:
    with Image.open(row["frame"]) as src:
        img = src.convert("RGB")
    draw = ImageDraw.Draw(img)
    scale = max(img.height, 480) / 720
    stroke = max(2, round(2 * scale))
    font = _font(max(12, round(18 * scale)))
    pad = max(2, round(4 * scale))

    preview = row.get("preview")
    if boxes and preview and preview.get("box"):
        x, y, w, h = preview["box"]
        meta = legend.get(str(row["class_id"])) or {}
        color = meta.get("color") or DEFAULT_COLOR
        draw.rectangle([x, y, x + w, y + h], outline=color, width=stroke)
        text = f"{meta.get('name') or row['class_name'] or 'cid ' + str(row['class_id'])} {preview.get('confidence') or 0:.2f}"
        tw = draw.textlength(text, font=font)
        th = font.size + pad * 2
        ty = y - th if y - th >= 0 else y
        draw.rectangle([x, ty, x + tw + pad * 2, ty + th], fill=color)
        draw.text((x + pad, ty + pad), text, fill=LABEL_TEXT, font=font)

    if data:
        gps = row.get("gps")
        lines = [
            f"Время: {_wall(row['started_at'])}",
            f"GPS: {gps['lat']:.5f}, {gps['lon']:.5f}" if gps else "GPS: нет данных",
        ]
        tw = max(draw.textlength(t, font=font) for t in lines)
        lh = font.size + pad
        draw.rectangle([pad, pad, pad + tw + pad * 4, pad + lh * len(lines) + pad * 2], fill="#000000")
        for i, text in enumerate(lines):
            draw.text((pad * 3, pad * 2 + i * lh), text, fill=PLATE_TEXT, font=font)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


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
