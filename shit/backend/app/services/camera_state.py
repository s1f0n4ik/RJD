import asyncio
from typing import Dict, List
from datetime import datetime


class CameraStateManager:
    """Управление состоянием камер напрямую"""

    def __init__(self):
        self.cameras: Dict[str, dict] = {}
        self.loaders: Dict[str, dict] = {}
        self._lock = asyncio.Lock()

    async def update_camera(self, camera_id: str, data: dict):
        async with self._lock:
            self.cameras[camera_id] = {
                **data,
                "last_update": datetime.utcnow().isoformat()
            }

    async def get_all_cameras(self) -> List[dict]:
        async with self._lock:
            return list(self.cameras.values())

    async def update_loader(self, loader_id: str, data: dict):
        async with self._lock:
            self.loaders[loader_id] = {
                **data,
                "last_update": datetime.utcnow().isoformat()
            }

    async def get_all_loaders(self) -> List[dict]:
        async with self._lock:
            return list(self.loaders.values())


camera_state = CameraStateManager()