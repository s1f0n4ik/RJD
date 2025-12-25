from fastapi import APIRouter, HTTPException, status
from typing import List
import logging

from app.models.loader import (
    LoaderCreate,
    LoaderUpdate,
    LoaderResponse,
    LoaderStatus as LoaderStatusModel,
    MatrixValidation,
    MatrixValidationRequest
)
from app.services import flask_client
from app.services.flask_client import FlaskClientError

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/loaders", response_model=List[LoaderResponse])
async def get_all_loaders():
    """Получить список всех загрузчиков"""
    try:
        loaders = await flask_client.get_all_loaders()
        return loaders
    except FlaskClientError as e:
        logger.error(f"Failed to get loaders: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Flask server error: {str(e)}"
        )


@router.post("/loader", response_model=LoaderResponse, status_code=status.HTTP_201_CREATED)
async def create_loader(loader: LoaderCreate):
    """Создать новый загрузчик"""
    try:
        result = await flask_client.create_loader(loader.dict())

        # Получаем статус созданного загрузчика
        loader_status = await flask_client.get_loader_status(loader.loader_name)
        return loader_status

    except FlaskClientError as e:
        logger.error(f"Failed to create loader: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.get("/loader/{loader_name}", response_model=LoaderStatusModel)
async def get_loader_status(loader_name: str):
    """Получить статус загрузчика"""
    try:
        loader_status = await flask_client.get_loader_status(loader_name)
        return loader_status
    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Loader '{loader_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e)
        )


@router.put("/loader/{loader_name}", response_model=LoaderResponse)
async def update_loader(loader_name: str, loader_update: LoaderUpdate):
    """Обновить загрузчик"""
    try:
        update_data = loader_update.dict(exclude_unset=True)

        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )

        result = await flask_client.update_loader(loader_name, update_data)
        loader_status = await flask_client.get_loader_status(loader_name)
        return loader_status

    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Loader '{loader_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/loader/{loader_name}/start")
async def start_loader(loader_name: str):
    """Запустить загрузчик"""
    try:
        result = await flask_client.start_loader(loader_name)
        return result
    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Loader '{loader_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/loader/{loader_name}/stop")
async def stop_loader(loader_name: str):
    """Остановить загрузчик"""
    try:
        result = await flask_client.stop_loader(loader_name)
        return result
    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Loader '{loader_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.delete("/loader/{loader_name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_loader(loader_name: str):
    """Удалить загрузчик"""
    try:
        await flask_client.delete_loader(loader_name)
        return None
    except FlaskClientError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Loader '{loader_name}' not found"
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e)
        )


@router.post("/loader/validate-matrix", response_model=MatrixValidation)
async def validate_matrix(request: MatrixValidationRequest):
    """Валидация матрицы камер"""
    try:
        # Получаем список всех камер
        cameras = await flask_client.get_all_cameras()
        camera_names = {cam["camera_name"] for cam in cameras}

        # Проверяем матрицу
        matrix_cameras = set()
        for row in request.loader_matrix:
            matrix_cameras.update(row)

        missing = list(matrix_cameras - camera_names)

        # Проверяем дубликаты
        all_cameras_list = [cam for row in request.loader_matrix for cam in row]
        duplicates = list({cam for cam in all_cameras_list if all_cameras_list.count(cam) > 1})

        return MatrixValidation(
            valid=len(missing) == 0 and len(duplicates) == 0,
            missing_cameras=missing,
            duplicate_cameras=duplicates
        )

    except FlaskClientError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e)
        )