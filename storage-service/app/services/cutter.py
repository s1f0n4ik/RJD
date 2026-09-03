"""
Склейка и выгрузка по индексу сегментов.

Куски подбираются по базе — в нормализованном времени изделия. Поток копируется
без перекодирования, поэтому левая граница ложится на ближайший предшествующий
ключевой кадр. Разрывы внутри диапазона проходятся насквозь: в файле их просто
нет, и время в нём идёт непрерывно.

Склейка — задача с результатом в каталоге выгрузок, по mp4 на дорожку.
Выгрузка сегментов как есть задачей не является: zip уходит клиенту потоком.
"""

import asyncio
import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from app.services import exports
from app.services.jobs import Job, JobStatus, jobs
from app.services.merger import run_ffmpeg_concat
from app.services.segments import index

logger = logging.getLogger(__name__)


def _stamp(ms: int) -> str:
    """Метка для имени файла в настенном времени изделия."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _pick(camera: str, stream: str, from_ms: int, to_ms: int) -> list[dict]:
    segments = index.range_segments(camera, stream, from_ms, to_ms)
    return [s for s in segments if Path(s["path"]).exists()]


def _recorded_ms(segments: list[dict], from_ms: int, to_ms: int) -> int:
    return sum(
        max(0, min(s["end_ms"], to_ms) - max(s["start_ms"], from_ms))
        for s in segments
    )


def _size(segments: list[dict]) -> int:
    total = 0
    for segment in segments:
        size = segment.get("size_bytes") or 0
        if not size:
            try:
                size = Path(segment["path"]).stat().st_size
            except OSError:
                size = 0
        total += size
    return total


# ── сегменты как есть: потоковый zip ──

def zip_entries(tracks: list[dict], from_ms: int, to_ms: int) -> tuple[list[tuple[Path, str]], str]:
    """Пары «файл, имя в архиве» (папка на камеру) и имя самого архива."""
    entries: list[tuple[Path, str]] = []
    cameras: list[str] = []

    for track in tracks:
        camera = track["camera"]
        for segment in _pick(camera, track["stream"], from_ms, to_ms):
            path = Path(segment["path"])
            entries.append((path, f"{camera}/{path.name}"))
            if camera not in cameras:
                cameras.append(camera)

    name = cameras[0] if len(cameras) == 1 else "archive"
    return entries, f"{name}_{_stamp(from_ms)}_{_stamp(to_ms)}.zip"


# ── склейка ──

async def run_cut_job(job: Job, *, tracks: list[dict], from_ms: int, to_ms: int):
    """Склейка диапазона копированием потока, по файлу на каждую дорожку."""
    try:
        if job.cancelled:
            return

        await jobs.update(job, status=JobStatus.QUEUED, message="Устройство занято")
        async with jobs.device_lock():
            if job.cancelled:
                return
            await _cut(job, tracks, from_ms, to_ms)

    except exports.NoRoom as e:
        logger.warning("Cut job %s refused: need %d, room %d", job.id, e.need, e.room)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=str(e))
        await jobs.cleanup(job)
    except Exception as e:
        logger.exception("Cut job %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)


async def _ensure_room(need: int) -> None:
    loop = asyncio.get_running_loop()
    available = await loop.run_in_executor(None, exports.room)
    if need > available:
        await jobs.evict(need - available)
        available = await loop.run_in_executor(None, exports.room)
    if need > available:
        raise exports.NoRoom(need, available)


async def _cut(job: Job, tracks: list[dict], from_ms: int, to_ms: int) -> None:
    await jobs.update(job, status=JobStatus.PARSING, progress=0.0, message="Подбираем сегменты")

    picked: list[tuple[dict, list[dict]]] = []
    for track in tracks:
        segments = _pick(track["camera"], track["stream"], from_ms, to_ms)
        if segments:
            picked.append((track, segments))

    if not picked:
        raise RuntimeError("No recordings in the selected range")

    # Результат весит как входные сегменты; faststart переписывает файл ещё раз
    sizes = [_size(segments) for _, segments in picked]
    await _ensure_room(sum(sizes) + max(sizes))

    job.files_total = sum(len(segments) for _, segments in picked)
    track_seconds = [_recorded_ms(segments, from_ms, to_ms) / 1000 for _, segments in picked]
    total_seconds = sum(track_seconds) or 1.0
    job.duration_seconds = sum(track_seconds)

    job.work_dir = exports.root() / job.id
    job.work_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.gettempdir())

    done_seconds = 0.0

    for number, (track, segments) in enumerate(picked, 1):
        if job.cancelled:
            return

        camera = track["camera"]
        seconds = track_seconds[number - 1]

        list_file = temp_dir / f"cut_{job.id}_{number}.txt"
        progress_file = temp_dir / f"progress_{job.id}_{number}.txt"
        output = job.work_dir / f"{camera}_{_stamp(from_ms)}_{_stamp(to_ms)}.mp4"
        job.temp_files.extend([list_file, progress_file])

        # Границы режутся самим concat-демуксером: -ss перед -i на фрагментном mp4
        # пакеты не отбрасывает, а inpoint ложится на ближайший ключевой кадр
        with open(list_file, "w") as handle:
            for segment in segments:
                escaped = segment["path"].replace("'", "'\\''")
                handle.write(f"file '{escaped}'\n")
                if segment is segments[0] and from_ms > segment["start_ms"]:
                    handle.write(f"inpoint {(from_ms - segment['start_ms']) / 1000:.3f}\n")
                if segment is segments[-1] and to_ms < segment["end_ms"]:
                    handle.write(f"outpoint {(to_ms - segment['start_ms']) / 1000:.3f}\n")

        await jobs.update(
            job, status=JobStatus.MERGING, progress=done_seconds / total_seconds,
            message=f"{camera} · дорожка {number} из {len(picked)}",
        )

        base = done_seconds

        # Доля считается по секундам всех дорожек: лёгкая камера даёт малый шаг
        async def on_progress(value: float, base=base, seconds=seconds) -> None:
            await jobs.update(job, progress=(base + value * seconds) / total_seconds)

        await run_ffmpeg_concat(
            list_file=list_file,
            output_file=output,
            progress_file=progress_file,
            expected_seconds=seconds,
            on_progress=on_progress,
            job=job,
            files_count=len(segments),
        )

        if not output.exists():
            raise RuntimeError(f"Output file was not created: {camera}")

        job.result_paths.append(output)
        done_seconds += seconds
        job.files_processed += len(segments)

    if job.cancelled:
        return

    if len(job.result_paths) == 1:
        job.result_path = job.result_paths[0]
        job.result_filename = job.result_path.name
        job.result_media_type = "video/mp4"
    else:
        job.result_filename = f"archive_{_stamp(from_ms)}_{_stamp(to_ms)}.zip"
        job.result_media_type = "application/zip"

    job.bytes_total = job.result_bytes()
    await jobs.update(
        job, status=JobStatus.READY, progress=1.0,
        message=f"Готово · {exports.fmt_size(job.bytes_total)}",
    )
