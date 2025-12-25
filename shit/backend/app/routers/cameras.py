from fastapi import APIRouter, HTTPException, status
from typing import List
import logging

from app.models.camera import (
    CameraCreate,
    CameraUpdate,
    CameraResponse,
    CameraStatus as CameraStatusModel
)
from app.services import flask_client
from app.services.flask_client import FlaskClientError

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/cameras", response_model=List[CameraResponse])
async def get_all_cameras():
    """Получить список всех камер"""
    try:
        cameras = await flask_client.get_all_cameras()
        return cameras
    except FlaskClientError as e:
        logger.error(f"Failed to get cameras: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Flask server error: {str(e)}"
        )


@router.post("/camera", response_model=CameraResponse, status_code=status.HTTP_201_CREATED)
async def create_camera(camera: CameraCreate):
    """Добавить новую камеру"""
    try:
        result = await flask_client.add_camera(camera.dict())

        # Получаем статус созданной камеры
        camera_status = await flask_client.get_camera_status(camera.camera_name)
        return camera_status

    except FlaskClientError as e:
        logger.error(f"Failed to create camera: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.get("/camera/{camera_name}", response_model=CameraStatusModel)
async def get_camera_status(camera_name: str):
    """Получить статус конкретной камеры"""
    try:
        camera_status = await flask_client.get_camera_status(camera_name)
        return camera_status
    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Camera '{camera_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e)
        )


@router.put("/camera/{camera_name}", response_model=CameraResponse)
async def update_camera(camera_name: str, camera_update: CameraUpdate):
    """Обновить параметры камеры"""
    try:
        # Фильтруем только заполненные поля
        update_data = camera_update.dict(exclude_unset=True)

        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )

        result = await flask_client.update_camera(camera_name, update_data)

        # Возвращаем обновленный статус
        camera_status = await flask_client.get_camera_status(camera_name)
        return camera_status

    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Camera '{camera_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.delete("/camera/{camera_name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_camera(camera_name: str):
    """Удалить камеру"""
    try:
        await flask_client.delete_camera(camera_name)
        return None
    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Camera '{camera_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e)
        )