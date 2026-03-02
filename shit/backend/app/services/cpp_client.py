import httpx
import os
from typing import List, Optional
from app.models.cpp_camera import CPPCamera, CPPCameraResponse, CPPCamerasResponse

MEDIA_CENTER_URL = os.getenv("MEDIA_CENTER_URL", "http://localhost:8888")


class MediaCenterClient:
    def __init__(self):
        self.base_url = MEDIA_CENTER_URL
        self.client = httpx.AsyncClient(timeout=10.0)

    async def get_cameras(self) -> List[CPPCamera]:
        """Получить все камеры"""
        try:
            response = await self.client.get(f"{self.base_url}/api/camera")
            data = response.json()

            if data.get("ret") == 1 and data.get("cameras"):
                return data["cameras"]
            return []
        except Exception as e:
            print(f"Error fetching cameras: {e}")
            return []

    async def get_camera(self, camera_name: str) -> Optional[CPPCamera]:
        """Получить камеру по имени"""
        try:
            response = await self.client.get(f"{self.base_url}/api/camera/{camera_name}")
            data = response.json()

            if data.get("ret") == 1 and data.get("camera"):
                return CPPCamera(**data["camera"])
            return None
        except Exception as e:
            print(f"Error fetching camera {camera_name}: {e}")
            return None

    async def create_camera(self, camera_data: CPPCamera) -> dict:
        """Создать камеру"""
        try:
            response = await self.client.post(
                f"{self.base_url}/camera",
                json=camera_data.dict()
            )
            return response.json()
        except Exception as e:
            return {"ret": 0, "description": str(e)}

    async def update_camera(self, camera_name: str, updates: dict) -> dict:
        """Обновить камеру"""
        try:
            response = await self.client.patch(
                f"{self.base_url}/camera/{camera_name}",
                json=updates
            )
            return response.json()
        except Exception as e:
            return {"ret": 0, "description": str(e)}

    async def delete_camera(self, camera_name: str) -> dict:
        """Удалить камеру"""
        try:
            response = await self.client.delete(
                f"{self.base_url}/api/camera/{camera_name}"
            )
            return response.json()
        except Exception as e:
            return {"ret": 0, "description": str(e)}

    async def get_camera_statuses(self) -> dict:
        """Получить статусы всех камер (только main.status, sub.status)"""
        try:
            response = await self.client.get(
                f"{self.base_url}/camera?fields=main.status,sub.status"
            )
            return response.json()
        except Exception as e:
            return {"ret": 0, "description": str(e), "result": []}


cpp_client = MediaCenterClient()