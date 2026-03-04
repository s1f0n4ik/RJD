from fastapi import APIRouter, HTTPException
from app.services.cpp_client import cpp_client
from typing import Dict, Any

router = APIRouter()


@router.get("/cameras")
async def get_cameras() -> Dict[str, Any]:
    """Получить все камеры"""
    cameras = await cpp_client.get_cameras()
    return {"cameras": cameras}


@router.get("/camera/{camera_name}")
async def get_camera(camera_name: str):
    """Получить камеру по имени"""
    camera = await cpp_client.get_camera(camera_name)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    return camera


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