from fastapi import APIRouter, HTTPException
from app.services.cpp_client import cpp_client
from app.models.cpp_camera import CPPCamera
from typing import List

router = APIRouter()


@router.get("/cameras", response_model=List[CPPCamera])
async def get_cameras():
    """Получить все камеры"""
    cameras = await cpp_client.get_cameras()
    return cameras


@router.get("/camera/{camera_name}")
async def get_camera(camera_name: str):
    """Получить камеру по имени"""
    camera = await cpp_client.get_camera(camera_name)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    return camera


@router.post("/camera")
async def create_camera(camera: CPPCamera):
    """Создать новую камеру"""
    result = await cpp_client.create_camera(camera)

    if result.get("ret") != 1:
        raise HTTPException(status_code=400, detail=result.get("description"))

    return result


@router.patch("/camera/{camera_name}")
async def update_camera(camera_name: str, updates: dict):
    """Обновить камеру"""
    result = await cpp_client.update_camera(camera_name, updates)

    if result.get("ret") != 1:
        raise HTTPException(status_code=400, detail=result.get("description"))

    return result


@router.delete("/camera/{camera_name}")
async def delete_camera(camera_name: str):
    """Удалить камеру"""
    result = await cpp_client.delete_camera(camera_name)

    if result.get("ret") != 1:
        raise HTTPException(status_code=400, detail=result.get("description"))

    return {"message": f"Camera {camera_name} deleted"}