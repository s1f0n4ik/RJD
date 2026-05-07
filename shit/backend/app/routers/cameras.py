from fastapi import APIRouter, HTTPException
from app.services.cpp_client import cpp_client
from typing import Dict, Any
import logging

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/cameras")
async def get_cameras() -> Dict[str, Any]:
    """Получить все камеры"""
    cameras = await cpp_client.get_cameras()

    # Преобразуем в массив для удобства фронтенда
    cameras_array = [
        {"name": name, **data}
        for name, data in cameras.items()
    ] if isinstance(cameras, dict) else []

    return {"cameras": cameras_array}


@router.get("/camera/{camera_name}")
async def get_camera(camera_name: str) -> Dict[str, Any]:
    """Получить конкретную камеру"""
    camera = await cpp_client.get_camera(camera_name)

    if not camera:
        raise HTTPException(status_code=404, detail=f"Camera {camera_name} not found")

    return {"camera": camera}


@router.post("/camera")
async def create_camera(camera_data: Dict[str, Any]):
    """Создать новую камеру"""
    logger.info(f"Creating camera: {camera_data.get('name')}")

    result = await cpp_client.create_camera(camera_data)

    if result.get("error"):
        raise HTTPException(
            status_code=400,
            detail=result["error"].get("message", "Failed to create camera")
        )

    return result

@router.patch("/camera/{camera_name}")
async def patch_camera(camera_name: str):
    """Изменить камеру"""
    logger.info(f"Изменение камеры: {camera_name}")

    result = await cpp_client.patch_camera(camera_name)

    if result.get("error"):
        raise HTTPException(
            status_code=400,
            detail=result["error"].get("message", "Failed to delete camera")
        )

    return {"message": f"Camera {camera_name} updated", "result": result}

@router.delete("/camera/{camera_name}")
async def delete_camera(camera_name: str):
    """Удалить камеру"""
    logger.info(f"Deleting camera: {camera_name}")

    result = await cpp_client.delete_camera(camera_name)

    if result.get("error"):
        raise HTTPException(
            status_code=400,
            detail=result["error"].get("message", "Failed to delete camera")
        )

    return {"message": f"Camera {camera_name} deleted", "result": result}