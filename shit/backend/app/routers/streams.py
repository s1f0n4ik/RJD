from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import httpx
import logging

from app.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/neural_{endpoint_id}")
async def stream_neural_endpoint(endpoint_id: int):
    """Проксируем MJPEG stream из Flask"""

    flask_url = f"{settings.FLASK_BASE_URL}/neural_{endpoint_id}"

    logger.info(f"Proxying stream from {flask_url}")

    try:
        async def stream_generator():
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", flask_url) as response:
                    if response.status_code != 200:
                        raise HTTPException(
                            status_code=response.status_code,
                            detail=f"Flask stream error: {response.status_code}"
                        )

                    async for chunk in response.aiter_bytes(chunk_size=8192):
                        yield chunk

        return StreamingResponse(
            stream_generator(),
            media_type="multipart/x-mixed-replace; boundary=frame"
        )

    except httpx.RequestError as e:
        logger.error(f"Failed to connect to Flask stream: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Flask stream unavailable: {str(e)}"
        )