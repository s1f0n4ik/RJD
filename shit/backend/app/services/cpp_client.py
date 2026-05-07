import httpx
import logging
from typing import Dict, Any
from app.config import settings

logger = logging.getLogger(__name__)

class MediaCenterClient:
    """Клиент для REST API Media Center (C++ сервер на порту 7777)"""

    def __init__(self):
        self.base_url = settings.MEDIA_CENTER_URL
        self.timeout = settings.MEDIA_CENTER_TIMEOUT

    async def get_cameras(self) -> Dict[str, Any]:
        """GET /camera - получить все камеры"""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(f"{self.base_url}/camera")
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
        """GET /camera?id=camera_X"""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(
                    f"{self.base_url}/camera",
                    params={"id": camera_name}
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
        """POST /camera - создать камеру"""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/camera",
                    json=camera_data
                )
                response.raise_for_status()
                return response.json()
        except Exception as e:
            logger.error(f"❌ Error creating camera: {e}")
            return {"data": None, "error": {"message": str(e)}}

    async def delete_camera(self, camera_name: str) -> Dict[str, Any]:
        """DELETE /camera?id=camera_X"""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.delete(
                    f"{self.base_url}/camera",
                    params={"id": camera_name}
                )
                response.raise_for_status()
                return response.json()
        except Exception as e:
            logger.error(f"❌ Error deleting camera: {e}")
            return {"data": None, "error": {"message": str(e)}}

cpp_client = MediaCenterClient()