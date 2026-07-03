from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Dict, Any
from datetime import datetime, timedelta
from pydantic import BaseModel
import subprocess
import logging
import tempfile
import time

router = APIRouter()
logger = logging.getLogger(__name__)

RECORDS_PATH = Path("/storage/internal")
TEMP_EXPORT_DIR = Path(tempfile.gettempdir()) / "rjd_recordings_exports"
TEMP_EXPORT_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_VIDEO_SUFFIXES = {'.mp4', '.mkv', '.avi', '.ts'}


class MergeRequest(BaseModel):
    camera: str
    date: str
    start_minutes: float
    end_minutes: float


def cleanup_old_exports(max_age_seconds: int = 3600):
    """Удаляем старые временные файлы экспорта."""
    now = time.time()

    try:
        for p in TEMP_EXPORT_DIR.glob("*"):
            try:
                if not p.is_file():
                    continue

                age = now - p.stat().st_mtime
                if age > max_age_seconds:
                    p.unlink(missing_ok=True)
                    logger.info(f"🗑️ Removed old temp export: {p}")
            except Exception as e:
                logger.warning(f"Failed to cleanup temp file {p}: {e}")
    except Exception as e:
        logger.warning(f"Failed to scan temp export dir {TEMP_EXPORT_DIR}: {e}")


def is_valid_video_file(path: Path) -> bool:
    """Проверяем, что файл читается и содержит видеопоток."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_type",
                "-of", "csv=p=0",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )

        stdout = (result.stdout or "").strip().lower()
        return result.returncode == 0 and "video" in stdout

    except subprocess.TimeoutExpired:
        logger.warning(f"⚠️ ffprobe timeout for file: {path}")
        return False
    except Exception as e:
        logger.warning(f"⚠️ ffprobe failed for {path}: {e}")
        return False


def remux_segment_to_ts(input_file: Path, output_ts: Path) -> bool:
    """
    Перегоняет ОДИН сегмент в MPEG-TS, максимально терпимо к битому хвосту.
    Если хвост битый — ffmpeg запишет то, что смог прочитать, и выйдет.
    Возвращает True, если получился непустой .ts.
    """
    cmd = [
        "ffmpeg",
        "-v", "error",
        "-err_detect", "ignore_err",   # не падать на битых пакетах
        "-fflags", "+discardcorrupt+genpts",  # выбрасывать битые пакеты, генерить PTS
        "-i", str(input_file),
        "-c", "copy",
        "-bsf:v", "h264_mp4toannexb",  # нужно для корректного mp4->ts
        "-f", "mpegts",
        "-y",
        str(output_ts),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        # returncode может быть !=0 даже когда часть данных записалась —
        # поэтому ориентируемся на факт наличия непустого файла.
        ok = output_ts.exists() and output_ts.stat().st_size > 1024
        if not ok:
            logger.warning(f"❌ ts remux produced nothing for {input_file.name}: {result.stderr[:300]}")
        return ok
    except subprocess.TimeoutExpired:
        logger.warning(f"⚠️ ts remux timeout for {input_file.name}")
        return output_ts.exists() and output_ts.stat().st_size > 1024
    except Exception as e:
        logger.warning(f"⚠️ ts remux exception for {input_file.name}: {e}")
        return False


def quote_ffmpeg_concat_path(path: Path) -> str:
    """Безопасное экранирование пути для concat list."""
    escaped = str(path.absolute()).replace("'", "'\\''")
    return f"file '{escaped}'\n"


@router.get("/recordings")
async def get_all_recordings() -> Dict[str, Any]:
    """Получить все записи, сгруппированные по камерам"""
    if not RECORDS_PATH.exists():
        logger.warning(f"Records path does not exist: {RECORDS_PATH}")
        return {
            "recordings": {},
            "message": f"Records path does not exist: {RECORDS_PATH}"
        }

    recordings = {}

    try:
        for camera_dir in RECORDS_PATH.iterdir():
            if not camera_dir.is_dir():
                continue

            camera_name = camera_dir.name
            files = []

            for video_file in camera_dir.glob("*"):
                if video_file.is_file() and video_file.suffix.lower() in ALLOWED_VIDEO_SUFFIXES:
                    stat = video_file.stat()
                    files.append({
                        "filename": video_file.name,
                        "size": stat.st_size,
                        "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    })

            files.sort(key=lambda x: x['created'], reverse=True)
            recordings[camera_name] = files

        logger.info(f"Found {len(recordings)} cameras with recordings")
        return {"recordings": recordings}

    except Exception as e:
        logger.error(f"Error getting recordings: {e}")
        return {"recordings": {}}


@router.get("/recordings/{camera_name}")
async def get_camera_recordings(camera_name: str):
    """Получить записи конкретной камеры"""
    camera_path = RECORDS_PATH / camera_name

    if not camera_path.exists():
        raise HTTPException(status_code=404, detail=f"Camera {camera_name} not found")

    files = []
    for video_file in camera_path.glob("*"):
        if video_file.is_file() and video_file.suffix.lower() in ALLOWED_VIDEO_SUFFIXES:
            stat = video_file.stat()
            files.append({
                "filename": video_file.name,
                "size": stat.st_size,
                "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })

    files.sort(key=lambda x: x['created'], reverse=True)
    return {"files": files}


@router.get("/recordings/download/{camera_name}/{filename}")
async def download_recording(camera_name: str, filename: str):
    """Скачать файл записи"""
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    file_path = RECORDS_PATH / camera_name / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="application/octet-stream"
    )


@router.get("/recordings/stream/{camera_name}/{filename}")
async def stream_recording(camera_name: str, filename: str):
    """Stream видео для проигрывания в браузере"""
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    file_path = RECORDS_PATH / camera_name / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        path=file_path,
        media_type="video/mp4"
    )


@router.post("/recordings/merge")
async def merge_recordings(request: MergeRequest):
    """
    Склеить видео в указанном диапазоне времени.
    Битые сегменты пропускаются.
    """

    cleanup_old_exports()

    logger.info(
        f"🎬 Merge request: {request.camera}, {request.date}, "
        f"{request.start_minutes}-{request.end_minutes} min"
    )

    camera_path = RECORDS_PATH / request.camera
    if not camera_path.exists():
        raise HTTPException(status_code=404, detail=f"Camera '{request.camera}' not found")

    all_files = sorted(
        [f for f in camera_path.glob("*.mp4") if f.is_file()],
        key=lambda x: x.name
    )

    if not all_files:
        raise HTTPException(status_code=404, detail="No video files found for this camera")

    logger.info(f"📁 Found {len(all_files)} total files for {request.camera}")

    try:
        date_obj = datetime.strptime(request.date, "%Y-%m-%d")
        start_time = date_obj + timedelta(minutes=request.start_minutes)
        end_time = date_obj + timedelta(minutes=request.end_minutes)

        logger.info(f"⏰ Range: {start_time.isoformat()} to {end_time.isoformat()}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")

    relevant_files = []

    for video_file in all_files:
        try:
            stat = video_file.stat()
            file_time = datetime.fromtimestamp(stat.st_ctime)
            file_end_time = file_time + timedelta(minutes=10)

            if file_time <= end_time and file_end_time >= start_time:
                relevant_files.append(video_file)
                logger.info(f"  ✅ selected: {video_file.name} (created: {file_time.strftime('%H:%M:%S')})")

        except Exception as e:
            logger.warning(f"  ⚠️ Skipping {video_file.name}: {e}")
            continue

    if not relevant_files:
        raise HTTPException(
            status_code=404,
            detail=f"No recordings found in time range {start_time.strftime('%H:%M')}-{end_time.strftime('%H:%M')}"
        )

    logger.info(f"🎯 Selected {len(relevant_files)} files before validation")

    valid_files = []
    skipped_files = []

    for video_file in relevant_files:
        if is_valid_video_file(video_file):
            valid_files.append(video_file)
            logger.info(f"  ✅ valid: {video_file.name}")
        else:
            skipped_files.append(video_file.name)
            logger.warning(f"  ❌ broken, skipped: {video_file.name}")

    if not valid_files:
        raise HTTPException(
            status_code=422,
            detail="Все выбранные сегменты повреждены, склейка невозможна"
        )

    logger.info(
        f"🎯 Valid files for merge: {len(valid_files)}; "
        f"skipped broken: {len(skipped_files)}"
    )

    timestamp = int(datetime.now().timestamp())
    list_file = TEMP_EXPORT_DIR / f"merge_{request.camera}_{timestamp}.txt"
    output_file = TEMP_EXPORT_DIR / (
        f"{request.camera}_{request.date}_"
        f"{int(request.start_minutes):04d}-{int(request.end_minutes):04d}.mp4"
    )

    ts_files: list[Path] = []

    def cleanup_ts():
        for ts in ts_files:
            try:
                ts.unlink(missing_ok=True)
            except Exception as e:
                logger.warning(f"Failed to remove temp ts {ts}: {e}")

    try:
        # 1) Нормализуем каждый валидный сегмент в отдельный .ts
        for idx, video_file in enumerate(valid_files):
            ts_path = TEMP_EXPORT_DIR / f"seg_{request.camera}_{timestamp}_{idx:04d}.ts"
            if remux_segment_to_ts(video_file, ts_path):
                ts_files.append(ts_path)
                logger.info(f"  ✅ ts ok: {video_file.name} -> {ts_path.name}")
            else:
                skipped_files.append(video_file.name)
                logger.warning(f"  ❌ ts skipped: {video_file.name}")

        if not ts_files:
            raise HTTPException(
                status_code=422,
                detail="После нормализации не осталось ни одного пригодного сегмента"
            )

        # 2) concat-список уже из .ts
        with open(list_file, 'w', encoding='utf-8') as f:
            for ts in ts_files:
                f.write(quote_ffmpeg_concat_path(ts))

        logger.info(f"📝 Created concat list: {list_file} ({len(ts_files)} ts segments)")

        # 3) Финальная склейка. genpts + разрыв timestamps => обрыв не ломает хвост.
        ffmpeg_cmd = [
            "ffmpeg",
            "-v", "error",
            "-err_detect", "ignore_err",
            "-fflags", "+genpts+discardcorrupt",
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_file),
            "-c", "copy",
            "-bsf:a", "aac_adtstoasc",  # убери, если аудио нет и ffmpeg ругается
            "-movflags", "+faststart",
            "-y",
            str(output_file)
        ]

        logger.info(f"🎬 Running FFmpeg: {' '.join(ffmpeg_cmd)}")

        result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=300)

        if result.returncode != 0:
            logger.error(f"❌ FFmpeg error: {result.stderr}")
            raise HTTPException(status_code=500, detail=f"FFmpeg failed: {result.stderr[:500]}")

        if not output_file.exists() or output_file.stat().st_size == 0:
            raise HTTPException(status_code=500, detail="Output file was not created")

        file_size = output_file.stat().st_size
        logger.info(f"📦 Output file size: {file_size / 1024 / 1024:.2f} MB")

        # чистим промежуточное
        list_file.unlink(missing_ok=True)
        cleanup_ts()

        response = FileResponse(
            path=output_file,
            media_type="video/mp4",
            filename=output_file.name
        )
        if skipped_files:
            response.headers["X-Skipped-Segments"] = str(len(skipped_files))
            response.headers["X-Skipped-Files"] = ", ".join(skipped_files[:20])
        return response

    except subprocess.TimeoutExpired:
        logger.error("❌ FFmpeg timeout (>5 minutes)")
        list_file.unlink(missing_ok=True)
        cleanup_ts()
        output_file.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Video merge timeout (>5 minutes).")

    except HTTPException:
        list_file.unlink(missing_ok=True)
        cleanup_ts()
        output_file.unlink(missing_ok=True)
        raise

    except Exception as e:
        logger.error(f"❌ Merge failed: {e}")
        list_file.unlink(missing_ok=True)
        cleanup_ts()
        output_file.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=str(e))