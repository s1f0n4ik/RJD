from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Dict, Any
from datetime import datetime, timedelta
from pydantic import BaseModel
import subprocess
import logging
import os
import tempfile

router = APIRouter()
logger = logging.getLogger(__name__)

RECORDS_PATH = Path("/home/orangepi/records")


class MergeRequest(BaseModel):
    """Запрос на склейку видео"""
    camera: str
    date: str  # YYYY-MM-DD
    start_minutes: float
    end_minutes: float


@router.get("/recordings")
async def get_all_recordings() -> Dict[str, Any]:
    """Получить все записи, сгруппированные по камерам"""
    if not RECORDS_PATH.exists():
        logger.warning(f"Records path does not exist: {RECORDS_PATH}")
        return {"recordings": {}}

    recordings = {}

    try:
        for camera_dir in RECORDS_PATH.iterdir():
            if not camera_dir.is_dir():
                continue

            camera_name = camera_dir.name
            files = []

            for video_file in camera_dir.glob("*"):
                if video_file.is_file() and video_file.suffix.lower() in ['.mp4', '.mkv', '.avi', '.ts']:
                    stat = video_file.stat()
                    files.append({
                        "filename": video_file.name,
                        "size": stat.st_size,
                        "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    })

            # Сортируем по времени создания (новые сверху)
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
        if video_file.is_file() and video_file.suffix.lower() in ['.mp4', '.mkv', '.avi', '.ts']:
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
    # Защита от path traversal
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
    # Защита от path traversal
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
    Склеить видео в указанном диапазоне времени

    Принимает:
    - camera: имя камеры
    - date: дата в формате YYYY-MM-DD
    - start_minutes: начало диапазона в минутах от начала дня (например, 600 = 10:00)
    - end_minutes: конец диапазона в минутах от начала дня

    Возвращает: склеенный MP4 файл
    """

    logger.info(f"🎬 Merge request: {request.camera}, {request.date}, {request.start_minutes}-{request.end_minutes} min")

    # 1. Проверяем существование камеры
    camera_path = RECORDS_PATH / request.camera
    if not camera_path.exists():
        raise HTTPException(status_code=404, detail=f"Camera '{request.camera}' not found")

    # 2. Находим все видео файлы камеры
    all_files = sorted(
        [f for f in camera_path.glob("*.mp4") if f.is_file()],
        key=lambda x: x.name
    )

    if not all_files:
        raise HTTPException(status_code=404, detail="No video files found for this camera")

    logger.info(f"📁 Found {len(all_files)} total files for {request.camera}")

    # 3. Фильтруем файлы по дате и времени
    try:
        date_obj = datetime.strptime(request.date, "%Y-%m-%d")
        start_time = date_obj + timedelta(minutes=request.start_minutes)
        end_time = date_obj + timedelta(minutes=request.end_minutes)

        logger.info(f"⏰ Range: {start_time.isoformat()} to {end_time.isoformat()}")

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")

    # 4. Отбираем файлы в диапазоне
    relevant_files = []

    for video_file in all_files:
        try:
            # Предполагаем формат файла: camera_YYYYMMDD_HHMMSS.mp4
            # Или просто используем время создания файла
            stat = video_file.stat()
            file_time = datetime.fromtimestamp(stat.st_ctime)

            # Каждый файл примерно 10 минут
            file_end_time = file_time + timedelta(minutes=10)

            # Проверяем пересечение с запрошенным диапазоном
            if file_time <= end_time and file_end_time >= start_time:
                relevant_files.append(video_file)
                logger.info(f"  ✅ {video_file.name} (created: {file_time.strftime('%H:%M:%S')})")

        except Exception as e:
            logger.warning(f"  ⚠️ Skipping {video_file.name}: {e}")
            continue

    if not relevant_files:
        raise HTTPException(
            status_code=404,
            detail=f"No recordings found in time range {start_time.strftime('%H:%M')}-{end_time.strftime('%H:%M')}"
        )

    logger.info(f"🎯 Selected {len(relevant_files)} files for merging")

    # 5. Создаем временные файлы
    temp_dir = Path(tempfile.gettempdir())
    timestamp = int(datetime.now().timestamp())

    # Файл со списком для FFmpeg
    list_file = temp_dir / f"merge_{request.camera}_{timestamp}.txt"

    # Выходной файл
    output_file = temp_dir / f"{request.camera}_{request.date}_{int(request.start_minutes):04d}-{int(request.end_minutes):04d}.mp4"

    try:
        # 6. Создаем список файлов для FFmpeg
        with open(list_file, 'w') as f:
            for video_file in relevant_files:
                # FFmpeg требует абсолютные пути и экранирование
                f.write(f"file '{video_file.absolute()}'\n")

        logger.info(f"📝 Created concat list: {list_file}")

        # 7. Запускаем FFmpeg для склейки
        ffmpeg_cmd = [
            "ffmpeg",
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_file),
            "-c", "copy",  # Копируем без перекодирования (БЫСТРО!)
            "-y",  # Перезаписать если существует
            str(output_file)
        ]

        logger.info(f"🎬 Running FFmpeg: {' '.join(ffmpeg_cmd)}")

        # Запускаем с таймаутом 5 минут
        result = subprocess.run(
            ffmpeg_cmd,
            capture_output=True,
            text=True,
            timeout=300
        )

        if result.returncode != 0:
            logger.error(f"❌ FFmpeg error: {result.stderr}")
            raise HTTPException(
                status_code=500,
                detail=f"FFmpeg failed: {result.stderr[:200]}"
            )

        logger.info(f"✅ Merge complete: {output_file}")

        # 8. Проверяем результат
        if not output_file.exists():
            raise HTTPException(status_code=500, detail="Output file was not created")

        file_size = output_file.stat().st_size
        logger.info(f"📦 Output file size: {file_size / 1024 / 1024:.2f} MB")

        # 9. Отправляем файл клиенту
        def cleanup():
            """Удаляем временные файлы после отправки"""
            try:
                if list_file.exists():
                    list_file.unlink()
                    logger.info(f"🗑️ Removed list file: {list_file}")
                if output_file.exists():
                    output_file.unlink()
                    logger.info(f"🗑️ Removed output file: {output_file}")
            except Exception as e:
                logger.error(f"Failed to cleanup: {e}")

        return FileResponse(
            path=output_file,
            media_type="video/mp4",
            filename=output_file.name,
            background=cleanup  # Автоматическая очистка после отправки
        )

    except subprocess.TimeoutExpired:
        logger.error("❌ FFmpeg timeout (>5 minutes)")
        # Очистка
        if list_file.exists():
            list_file.unlink()
        if output_file.exists():
            output_file.unlink()

        raise HTTPException(
            status_code=500,
            detail="Video merge timeout (>5 minutes). Try shorter time range."
        )

    except Exception as e:
        logger.error(f"❌ Merge failed: {e}")

        # Очистка
        if list_file.exists():
            list_file.unlink()
        if output_file.exists():
            output_file.unlink()

        raise HTTPException(status_code=500, detail=str(e))