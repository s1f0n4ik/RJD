import httpx
import os
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

MEDIA_CENTER_URL = os.getenv("MEDIA_CENTER_URL", "http://media-center:7777")


class MediaCenterClient:
    """Клиент для REST API Media Center (только управление!)"""

    def __init__(self):
        self.base_url = MEDIA_CENTER_URL
        self.client = httpx.AsyncClient(timeout=10.0)

    async def get_cameras(self) -> Dict[str, Any]:
        """GET /camera - получить все камеры"""
        try:
            response = await self.client.get(f"{self.base_url}/camera")
            response.raise_for_status()
            data = response.json()

            if data.get("error"):
                logger.error(f"Media Center error: {data['error']}")
                return {}

            return data.get("data", {}).get("cameras", {})

        except Exception as e:
            logger.error(f"❌ Error fetching cameras: {e}")
            return {}

    async def get_camera(self, camera_name: str) -> Dict[str, Any]:
        """GET /camera?name=camera_X"""
        try:
            response = await self.client.get(
                f"{self.base_url}/camera",
                params={"name": camera_name}
            )
            response.raise_for_status()
            data = response.json()

            if data.get("error"):
                return None

            cameras = data.get("data", {}).get("cameras", {})
            return cameras.get(camera_name)

        except Exception as e:
            logger.error(f"❌ Error fetching camera {camera_name}: {e}")
            return None

    async def create_camera(self, camera_data: Dict[str, Any]) -> Dict[str, Any]:
        """POST /camera"""
        try:
            response = await self.client.post(
                f"{self.base_url}/camera",
                json=camera_data
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"❌ Error creating camera: {e}")
            return {"data": None, "error": {"message": str(e)}}

    async def delete_camera(self, camera_name: str) -> Dict[str, Any]:
        """DELETE /camera?name=camera_X"""
        try:
            response = await self.client.delete(
                f"{self.base_url}/camera",
                params={"name": camera_name}
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"❌ Error deleting camera: {e}")
            return {"data": None, "error": {"message": str(e)}}


cpp_client = MediaCenterClient()