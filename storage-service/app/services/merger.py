import asyncio
import logging
import re
import subprocess
import tempfile
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from app.config import settings
from app.services.jobs import Job, JobStatus, jobs
from app.services.storage import storage

logger = logging.getLogger(__name__)


async def run_merge_job(
        job: Job,
        *,
        camera: str,
        date: str,
        start_minutes: float,
        end_minutes: float,
):
    """
    Полный жизненный цикл задачи склейки. Сама обновляет прогресс job через jobs.update().
    """
    try:
        if job.cancelled:
            return
        # ── Фаза 1: парсинг ──
        await jobs.update(job, status=JobStatus.PARSING, message="Подбираем фрагменты...")

        camera_path = storage.root / camera
        if not camera_path.is_dir():
            raise RuntimeError(f"Camera '{camera}' not found")

        try:
            date_obj = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise RuntimeError("Invalid date format, expected YYYY-MM-DD")

        start_time = date_obj + timedelta(minutes=start_minutes)
        end_time = date_obj + timedelta(minutes=end_minutes)

        relevant = _collect_files(camera_path, start_time, end_time)
        if not relevant:
            raise RuntimeError("No recordings in the selected range")

        logger.info("Job %s: %d files in range", job.id, len(relevant))

        if job.cancelled:
            return

        # ── Фаза 2: подготовка ──
        temp_dir = Path(tempfile.gettempdir())
        timestamp = int(datetime.now().timestamp())
        list_file = temp_dir / f"merge_{camera}_{timestamp}.txt"
        output_mp4 = temp_dir / (
            f"{camera}_{date}_"
            f"{int(start_minutes):04d}-{int(end_minutes):04d}.mp4"
        )
        progress_file = temp_dir / f"progress_{job.id}.txt"
        job.temp_files.extend([list_file, progress_file])

        # ── Фаза 3: отсев битых фрагментов ──
        # Проверяем файлы параллельно (ffprobe читает только заголовки и длину),
        # битые выкидываем. Метрики считаем по фактически годным файлам, а не по
        # выбранному отрезку: длительность — сумма их длительностей, число файлов —
        # общее минус битые. Целые фрагменты склеиваются одним проходом, поэтому
        # разрыв записи (система была выключена) не останавливает склейку.
        await jobs.update(
            job,
            status=JobStatus.PARSING,
            message=f"Проверка {len(relevant)} фрагментов...",
        )

        checked = await _probe_all(relevant, job)
        if job.cancelled:
            return
        valid_files = [f for f, dur in checked if dur is not None]
        if not valid_files:
            raise RuntimeError("Все выбранные фрагменты повреждены, склейка невозможна")

        total_duration = sum(dur for _, dur in checked if dur is not None)
        skipped = len(relevant) - len(valid_files)
        job.files_total = len(valid_files)
        job.duration_seconds = total_duration
        job.bytes_total = 0

        with open(list_file, "w") as f:
            for v in valid_files:
                escaped = str(v.absolute()).replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        # ── Фаза 4: склейка одним проходом с живым прогрессом ──
        merge_msg = f"Склейка {len(valid_files)} фрагментов..."
        if skipped:
            merge_msg += f" (пропущено битых: {skipped})"
        await jobs.update(job, status=JobStatus.MERGING, progress=0.0, message=merge_msg)

        await _run_ffmpeg_with_progress(
            list_file=list_file,
            output_file=output_mp4,
            progress_file=progress_file,
            expected_seconds=total_duration,
            on_progress=lambda p: jobs.update(job, progress=p),
            job=job,
            files_count=len(valid_files),
        )

        if not output_mp4.exists():
            raise RuntimeError("Output file was not created")

        job.temp_files.append(output_mp4)
        job.result_path = output_mp4
        job.result_filename = output_mp4.name
        job.result_media_type = "video/mp4"

        out_size = output_mp4.stat().st_size
        job.files_processed = len(valid_files)
        job.bytes_total = out_size
        size_mb = out_size / 1024 ** 2
        await jobs.update(
            job,
            status=JobStatus.READY,
            progress=1.0,
            message=f"Готово ({size_mb:.1f} МБ)",
        )

    except Exception as e:
        logger.exception("Job %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)


async def run_archive_job(
        job: Job,
        *,
        camera: str,
        date: str,
        mode: str,
        start_minutes: float | None,
        end_minutes: float | None,
):
    try:
        await jobs.update(job, status=JobStatus.PARSING, message="Подбираем файлы...")

        camera_path = storage.root / camera
        if not camera_path.is_dir():
            raise RuntimeError(f"Camera '{camera}' not found")

        try:
            date_obj = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise RuntimeError("Invalid date format")

        # Подбор файлов
        if mode == "range":
            start_time = date_obj + timedelta(minutes=start_minutes)
            end_time = date_obj + timedelta(minutes=end_minutes)
            files = _collect_files(camera_path, start_time, end_time)
        else:  # day
            day_start = date_obj
            day_end = date_obj + timedelta(days=1)
            files = _collect_files(camera_path, day_start, day_end)

        if not files:
            raise RuntimeError("No recordings found")

        total_bytes = sum(f.stat().st_size for f in files)
        job.files_total = len(files)

        await jobs.update(
            job,
            status=JobStatus.ARCHIVING,
            progress=0.0,
            message=f"Архивация {len(files)} файлов...",
        )

        # Имя архива
        temp_dir = Path(tempfile.gettempdir())
        if mode == "range":
            archive_name = (
                f"{camera}_{date}_"
                f"{int(start_minutes):04d}-{int(end_minutes):04d}.zip"
            )
        else:
            archive_name = f"{camera}_{date}_full_day.zip"

        output_zip = temp_dir / archive_name
        job.temp_files.append(output_zip)

        # Архивация в executor с прогрессом
        await _zip_many_files(
            files=files,
            target=output_zip,
            total_bytes=total_bytes,
            job=job,
        )

        if job.cancelled:
            return

        job.result_path = output_zip
        job.result_filename = output_zip.name
        job.result_media_type = "application/zip"
        job.bytes_total = output_zip.stat().st_size

        size_mb = output_zip.stat().st_size / 1024 ** 2
        await jobs.update(
            job,
            status=JobStatus.READY,
            progress=1.0,
            message=f"Готово ({size_mb:.1f} МБ)",
        )

    except Exception as e:
        logger.exception("Archive job %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)


async def _zip_many_files(*, files: list[Path], target: Path, total_bytes: int, job):
    """
    Архивирует несколько файлов с честным прогрессом по байтам.
    Запускается в executor, чтобы не блокировать event loop.
    """
    import zipfile
    loop = asyncio.get_running_loop()

    # Контейнер для прогресса — обновляется из executor, читается из main loop
    state = {"bytes_done": 0, "files_done": 0, "cancelled": False}

    def _do_zip():
        with zipfile.ZipFile(target, "w", zipfile.ZIP_STORED) as zf:
            # ZIP_STORED — без компрессии. mp4 уже сжатый, deflate даст 1-3%
            # выигрыша, но времени потратит сильно больше.
            for f in files:
                if state["cancelled"]:
                    return
                with open(f, "rb") as src, zf.open(f.name, "w") as dst:
                    while True:
                        if state["cancelled"]:
                            return
                        chunk = src.read(1024 * 1024)  # 1 МБ
                        if not chunk:
                            break
                        dst.write(chunk)
                        state["bytes_done"] += len(chunk)
                state["files_done"] += 1

    zip_task = loop.run_in_executor(None, _do_zip)

    # Параллельно — рассылка прогресса
    while not zip_task.done():
        if job.cancelled:
            state["cancelled"] = True
            try:
                await zip_task
            except Exception:
                pass
            target.unlink(missing_ok=True)
            return

        await asyncio.sleep(0.5)
        if total_bytes > 0:
            progress = state["bytes_done"] / total_bytes
            job.files_processed = state["files_done"]
            job.bytes_total = state["bytes_done"]
            await jobs.update(job, progress=min(progress, 0.99))

    # Дожидаемся завершения и пробрасываем исключение, если было
    await zip_task

def _collect_files(camera_path: Path, start: datetime, end: datetime) -> list[Path]:
    out = []
    for f in sorted(camera_path.glob("*.mp4")):
        if not f.is_file():
            continue
        try:
            ft = datetime.fromtimestamp(f.stat().st_ctime)
        except OSError:
            continue
        f_end = ft + timedelta(minutes=10)
        if ft <= end and f_end >= start:
            out.append(f)
    return out


# ── ffmpeg с парсингом прогресса ──

_TIME_RE = re.compile(r"out_time_ms=(\d+)")


async def _probe_duration(path: Path) -> float | None:
    """
    Длительность видеофайла в секундах или None, если файл пустой либо битый.
    ffprobe читает только заголовки, поэтому дёшево — заодно служит проверкой
    целостности: оборванный при выключении питания файл длину не отдаст.
    """
    try:
        if path.stat().st_size < 1024:
            return None
    except OSError:
        return None

    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        str(path),
    ]
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        if proc.returncode != 0:
            return None
        text = out.decode(errors="replace").strip()
        dur = float(text) if text and text.lower() != "n/a" else 0.0
        return dur if dur > 0 else None
    except asyncio.TimeoutError:
        if proc:
            proc.kill()
            await proc.wait()
        return None
    except Exception as e:
        logger.warning("ffprobe failed for %s: %s", path.name, e)
        return None


async def _probe_all(files: list[Path], job) -> list[tuple[Path, float | None]]:
    """
    Параллельно измеряет длительность и целостность файлов. Порядок сохраняется.
    Возвращает пары (файл, длительность|None); None — битый файл.
    """
    sem = asyncio.Semaphore(8)

    async def check(f: Path):
        async with sem:
            if job.cancelled:
                return f, None
            return f, await _probe_duration(f)

    results = await asyncio.gather(*[check(f) for f in files])
    for f, dur in results:
        if dur is None:
            logger.warning("Job %s: skipped broken segment %s", job.id, f.name)
    return results


async def _run_ffmpeg_with_progress(
        *, list_file, output_file, progress_file, expected_seconds,
        on_progress, job, files_count,
):
    cmd = [
        "ffmpeg",
        "-err_detect", "ignore_err",
        "-fflags", "+genpts+discardcorrupt",
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        "-movflags", "+faststart",
        "-progress", str(progress_file),
        "-y",
        str(output_file),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    job.process = proc

    poll_task = asyncio.create_task(
        _poll_progress(progress_file, expected_seconds, on_progress, proc, job, output_file, files_count)
    )

    try:
        _, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=settings.MERGE_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError("Merge timeout — try a shorter range")
    finally:
        poll_task.cancel()
        job.process = None
        try:
            await poll_task
        except asyncio.CancelledError:
            pass

    if job.cancelled:
        raise RuntimeError("Cancelled")

    if proc.returncode != 0:
        err = (stderr or b"").decode(errors="replace")[-500:]
        raise RuntimeError(f"ffmpeg failed: {err}")


async def _poll_progress(
        progress_file: Path,
        expected_seconds: float,
        on_progress,
        proc: asyncio.subprocess.Process,
        job,
        output_file: Path,
        files_count: int,
):
    last_progress = 0.0
    while proc.returncode is None:
        await asyncio.sleep(0.5)
        if not progress_file.exists():
            continue
        try:
            text = progress_file.read_text(errors="replace")
        except OSError:
            continue

        matches = _TIME_RE.findall(text)
        if not matches:
            continue
        out_seconds = int(matches[-1]) / 1_000_000
        if expected_seconds <= 0:
            continue
        progress = out_seconds / expected_seconds

        # Метрики
        files_done = min(
            files_count,
            int((out_seconds / max(expected_seconds, 1)) * files_count) + 1,
            )
        try:
            cur_bytes = output_file.stat().st_size if output_file.exists() else 0
        except OSError:
            cur_bytes = 0

        if progress - last_progress >= 0.01 or files_done != job.files_processed:
            last_progress = progress
            job.files_processed = files_done
            job.bytes_total = cur_bytes
            await on_progress(min(progress, 0.99))


# ── Архивация ──

async def _zip_file(*, source: Path, target: Path, on_progress):
    """Архивирует один файл в zip с периодическим обновлением прогресса."""
    loop = asyncio.get_running_loop()
    total_size = source.stat().st_size

    def _do_zip():
        # Простой stored-zip без сжатия был бы быстрее, но мы кладём
        # как deflate чтобы реально экономить место. Если хочется максимально
        # быстро — поменяй на ZIP_STORED.
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
            zf.write(source, arcname=source.name)

    # Простой подход: запускаем зип в executor, параллельно — таймер на проценты.
    zip_task = loop.run_in_executor(None, _do_zip)

    # Простой эвристический прогресс по размеру целевого файла
    while not zip_task.done():
        await asyncio.sleep(0.5)
        if target.exists():
            try:
                cur = target.stat().st_size
                # zip обычно меньше source, но как индикатор подходит
                progress = min(cur / total_size, 0.95)
                await on_progress(progress)
            except OSError:
                pass

    await zip_task
    await on_progress(1.0)