import logging
from typing import Any, Dict

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class MediaCenterClient:
    """
    Тонкий read-only клиент к C++ Media Center.

    Используется только внутренними службами FastAPI (websocket_manager),
    которым нужно периодически опрашивать состояние камер.

    Все write-операции и доступ от фронта идут напрямую через nginx,
    минуя FastAPI.
    """

    def __init__(self) -> None:
        self.base_url = settings.MEDIA_CENTER_URL
        self.timeout = settings.MEDIA_CENTER_TIMEOUT

    async def get_cameras(self) -> Dict[str, Any]:
        """
        GET /camera → {camera_1: {...}, camera_2: {...}}

        Возвращает пустой dict при любой ошибке, чтобы не валить broadcast.
        """
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(f"{self.base_url}/camera")
                response.raise_for_status()
                payload = response.json()

                if payload.get("error"):
                    logger.error("Media Center error: %s", payload["error"])
                    return {}

                return payload.get("data", {}).get("cameras", {})

        except Exception as e:
            logger.error("❌ Error fetching cameras: %s", e)
            return {}


cpp_client = MediaCenterClient()