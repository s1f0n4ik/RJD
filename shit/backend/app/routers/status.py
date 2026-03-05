from fastapi import APIRouter, HTTPException
from typing import Dict, Any
import logging

from app.services import flask_client
from app.services.flask_client import FlaskClientError

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/status/system")
async def get_system_status() -> Dict[str, Any]:
    """Получить общий статус системы"""
    try:
        cameras = await flask_client.get_all_cameras()
        loaders = await flask_client.get_all_loaders()

        return {
            "cameras": {
                "total": len(cameras),
                "running": sum(1 for c in cameras if c.get("status") == "running"),
                "failed": sum(1 for c in cameras if c.get("status") == "failed")
            },
            "loaders": {
                "total": len(loaders),
                "running": sum(1 for l in loaders if l.get("status") == "running"),
                "stopped": sum(1 for l in loaders if l.get("status") == "stopped")
            }
        }

    except FlaskClientError as e:
        logger.error(f"Failed to get system status: {e}")
        raise HTTPException(
            status_code=503,
            detail="Flask server unavailable"
        )


@router.get("/status/endpoints")
async def get_available_endpoints():
    """Получить доступные MJPEG endpoints"""
    from app.config import settings

    return {
        "endpoints": settings.AVAILABLE_ENDPOINTS,
        "base_url": settings.FLASK_BASE_URL
    }