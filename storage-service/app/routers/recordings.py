import logging
import re

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.services.merger import MergeError, merge_range
from app.services.storage import storage

logger = logging.getLogger(__name__)
router = APIRouter()


class MergeRequest(BaseModel):
    camera: str
    date: str
    start_minutes: float
    end_minutes: float


@router.get("/recordings")
async def list_all():
    return {"recordings": storage.list_all()}


@router.get("/recordings/{camera_name}")
async def list_camera(camera_name: str):
    files = storage.list_camera(camera_name)
    if files is None:
        raise HTTPException(status_code=404, detail=f"Camera {camera_name} not found")
    return {"files": files}


@router.get("/recordings/download/{camera_name}/{filename}")
async def download(camera_name: str, filename: str):
    file_path = storage.resolve_file(camera_name, filename)
    if file_path is None:
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="application/octet-stream",
    )


@router.get("/recordings/stream/{camera_name}/{filename}")
async def stream(camera_name: str, filename: str, request: Request):
    file_path = storage.resolve_file(camera_name, filename)
    if file_path is None:
        raise HTTPException(status_code=404, detail="File not found")

    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")

    if range_header is None:
        return FileResponse(
            file_path,
            media_type="video/mp4",
            headers={"Accept-Ranges": "bytes"},
        )

    match = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not match:
        raise HTTPException(status_code=416, detail="Invalid range header")

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else file_size - 1

    if start >= file_size or end >= file_size or start > end:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    length = end - start + 1

    def iterate_file():
        chunk_size = settings.STREAM_CHUNK_SIZE
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(chunk_size, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        iterate_file(),
        status_code=206,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
            "Content-Type": "video/mp4",
        },
    )


@router.post("/recordings/merge")
async def merge_endpoint(req: MergeRequest):
    try:
        output_file, list_file = merge_range(
            req.camera, req.date, req.start_minutes, req.end_minutes
        )
    except MergeError as e:
        raise HTTPException(status_code=400, detail=str(e))

    def cleanup():
        list_file.unlink(missing_ok=True)
        output_file.unlink(missing_ok=True)

    return FileResponse(
        path=output_file,
        media_type="video/mp4",
        filename=output_file.name,
        background=cleanup,
    )