from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Dict, Any
from datetime import datetime
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

RECORDS_PATH = Path("/home/orangepi/records")


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