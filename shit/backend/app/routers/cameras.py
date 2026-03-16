from fastapi import APIRouter, HTTPException
from app.services.cpp_client import cpp_client
from typing import Dict, Any

router = APIRouter()


@router.get("/cameras")
async def get_cameras() -> Dict[str, Any]:
    """Получить все камеры"""
    cameras = await cpp_client.get_cameras()
    return {"cameras": cameras}


@router.get("/cameras")
async def get_cameras() -> Dict[str, Any]:
    """Получить все камеры"""
    cameras = await cpp_client.get_cameras()
    cameras_array = [
        {"name": name, **data}
        for name, data in cameras.items()
    ] if isinstance(cameras, dict) else cameras

    return {"cameras": cameras_array}


@router.post("/camera")
async def create_camera(camera_data: Dict[str, Any]):
    """Создать новую камеру"""
    result = await cpp_client.create_camera(camera_data)

    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"]["message"])

    return result


@router.delete("/camera/{camera_name}")
async def delete_camera(camera_name: str):
    """Удалить камеру"""
    result = await cpp_client.delete_camera(camera_name)

    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"]["message"])

    return {"message": f"Camera {camera_name} deleted"}