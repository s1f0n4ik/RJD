"""
Выгрузка кадров журнала архивом по фильтрам списка.

Задача того же менеджера, что и склейка архива: очередь на устройство, квота
каталога выгрузок, прогресс по WS, отмена. Кадры в журнале чистые, рамки и
плашка времени/координат наносятся здесь по данным записи — тем же составом,
что оверлей шлюза в media-center. Без наложений JPEG уходит как есть.
"""

import asyncio
import io
import json
import logging
import re
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from app.services import exports
from app.services.cutter import _ensure_room
from app.services.jobs import Job, JobStatus, jobs
from app.services.journal import journal

logger = logging.getLogger(__name__)

FONT_PATH = Path(__file__).resolve().parents[2] / "fonts" / "PTSans-Regular.ttf"
DEFAULT_COLOR = "#5b9dff"
LABEL_TEXT = "#08101f"
PLATE_TEXT = "#ffffff"
JPEG_QUALITY = 90
# Кадров на один заход в поток: между заходами обновляется прогресс и проверяется отмена
CHUNK = 20

_SAFE = re.compile(r"[^A-Za-z0-9_-]+")


@lru_cache(maxsize=8)
def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_PATH), size)


def _stamp(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _wall(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%d.%m.%Y %H:%M:%S")


def _entry_name(row: dict) -> str:
    camera = _SAFE.sub("_", row["camera_id"] or "cam").strip("_") or "cam"
    return f"{_stamp(row['ts'])}_{camera}_{row['id']}.jpg"


def _draw(path: Path, row: dict, *, boxes: bool, data: bool, legend: dict) -> bytes:
    with Image.open(path) as src:
        img = src.convert("RGB")
    draw = ImageDraw.Draw(img)
    scale = max(img.height, 480) / 720
    stroke = max(2, round(2 * scale))
    font = _font(max(12, round(18 * scale)))
    pad = max(2, round(4 * scale))

    if boxes:
        for obj in row["objects"]:
            x, y, w, h = obj["box"]
            meta = legend.get(str(obj["cid"])) or {}
            color = meta.get("color") or DEFAULT_COLOR
            draw.rectangle([x, y, x + w, y + h], outline=color, width=stroke)
            text = f"{meta.get('name') or 'cid ' + str(obj['cid'])} {obj.get('cf', 0):.2f}"
            tw = draw.textlength(text, font=font)
            th = font.size + pad * 2
            ty = y - th if y - th >= 0 else y
            draw.rectangle([x, ty, x + tw + pad * 2, ty + th], fill=color)
            draw.text((x + pad, ty + pad), text, fill=LABEL_TEXT, font=font)

    if data:
        gps = row.get("gps")
        lines = [
            f"Время: {_wall(row['ts'])}",
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


def _pack_chunk(zf: zipfile.ZipFile, rows: list[dict], *, boxes: bool, data: bool, legend: dict) -> int:
    """Кладёт порцию кадров в архив; возвращает число записанных."""
    written = 0
    for row in rows:
        path = row["frame"]
        if path is None:
            continue
        name = _entry_name(row)
        try:
            if boxes or data:
                zf.writestr(name, _draw(path, row, boxes=boxes, data=data, legend=legend))
            else:
                zf.write(path, name)
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


def _weigh(rows: list[dict]) -> int:
    """Суммарный размер существующих кадров; исчезнувшие помечает как отсутствующие."""
    total = 0
    for row in rows:
        path = row["frame"]
        if path is None:
            continue
        try:
            total += path.stat().st_size
        except OSError:
            row["frame"] = None
    return total


async def run_journal_export(job: Job, *, filters: dict, boxes: bool, data: bool, legend: dict):
    try:
        if job.cancelled:
            return
        await jobs.update(job, status=JobStatus.QUEUED, message="Устройство занято")
        async with jobs.device_lock():
            if job.cancelled:
                return
            await _export(job, filters, boxes, data, legend)

    except exports.NoRoom as e:
        logger.warning("Journal export %s refused: need %d, room %d", job.id, e.need, e.room)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=str(e))
        await jobs.cleanup(job)
    except Exception as e:
        logger.exception("Journal export %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)


async def _export(job: Job, filters: dict, boxes: bool, data: bool, legend: dict) -> None:
    loop = asyncio.get_running_loop()
    await jobs.update(job, status=JobStatus.PARSING, progress=0.0, message="Подбираем записи")

    rows = await loop.run_in_executor(None, lambda: journal.export_rows(**filters))
    if not rows:
        raise RuntimeError("No detections match the filters")

    # Перерисованный JPEG весит примерно как исходный; сверх того — json
    need = await loop.run_in_executor(None, _weigh, rows)
    await _ensure_room(need + len(rows) * 512)

    present = [r for r in rows if r["frame"] is not None]
    job.files_total = len(present)
    job.bytes_total = need
    job.work_dir = exports.root() / job.id
    job.work_dir.mkdir(parents=True, exist_ok=True)

    first, last = rows[0]["ts"], rows[-1]["ts"]
    output = job.work_dir / f"journal_{_stamp(first)}_{_stamp(last)}.zip"
    job.result_paths = [output]
    job.result_filename = output.name
    job.result_media_type = "application/zip"

    done = 0
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as zf:
        for start in range(0, len(present), CHUNK):
            if job.cancelled:
                return
            chunk = present[start:start + CHUNK]
            await jobs.update(
                job, status=JobStatus.ARCHIVING, progress=done / max(1, len(present)),
                message=f"Кадр {start + 1} из {len(present)}",
            )
            done += await loop.run_in_executor(
                None, lambda c=chunk: _pack_chunk(zf, c, boxes=boxes, data=data, legend=legend),
            )
            job.files_processed = done
        zf.writestr("detections.json", _sidecar(rows))

    if job.cancelled:
        return

    missing = len(rows) - done
    message = f"Собрано кадров: {done}"
    if missing:
        message += f", уже удалены: {missing}"
    logger.info("Journal export %s: %d frames, %d missing", job.id, done, missing)
    await jobs.update(job, status=JobStatus.READY, progress=1.0, message=message)
