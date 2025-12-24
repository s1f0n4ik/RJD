from pydantic import BaseModel, Field, validator
from typing import List, Optional
from datetime import datetime


class LoaderBase(BaseModel):
    """Базовая модель загрузчика"""
    loader_name: str = Field(..., min_length=1, max_length=50, description="Уникальное имя загрузчика")
    weights_path: str = Field(..., description="Путь к .rknn весам")
    classes_path: str = Field(..., description="Путь к .json классам")
    img_size: int = Field(..., description="Размер входного изображения")
    server_endpoint: str = Field(..., description="Endpoint для MJPEG: /neural_1, /neural_2, /neural_3")
    loader_matrix: List[List[str]] = Field(..., min_items=1, description="Матрица размещения камер")

    @validator('weights_path')
    def validate_weights_path(cls, v):
        if not v.endswith('.rknn'):
            raise ValueError('weights_path должен заканчиваться на .rknn')
        return v

    @validator('classes_path')
    def validate_classes_path(cls, v):
        if not v.endswith('.json'):
            raise ValueError('classes_path должен заканчиваться на .json')
        return v

    @validator('img_size')
    def validate_img_size(cls, v):
        allowed_sizes = [320, 416, 640, 1280]
        if v not in allowed_sizes:
            raise ValueError(f'img_size должен быть одним из {allowed_sizes}')
        return v

    @validator('server_endpoint')
    def validate_endpoint(cls, v):
        from app.config import settings
        if v not in settings.AVAILABLE_ENDPOINTS:
            raise ValueError(f'endpoint должен быть одним из {settings.AVAILABLE_ENDPOINTS}')
        return v

    @validator('loader_matrix')
    def validate_matrix(cls, v):
        if not v or not any(v):
            raise ValueError('loader_matrix не может быть пустой')

        for row in v:
            if not row:
                raise ValueError('В матрице не может быть пустых строк')

        return v


class LoaderCreate(LoaderBase):
    """Модель для создания загрузчика"""
    pass


class LoaderUpdate(BaseModel):
    """Модель для обновления загрузчика"""
    weights_path: Optional[str] = None
    classes_path: Optional[str] = None
    img_size: Optional[int] = None
    server_endpoint: Optional[str] = None
    loader_matrix: Optional[List[List[str]]] = None

    @validator('weights_path')
    def validate_weights_path(cls, v):
        if v is not None and not v.endswith('.rknn'):
            raise ValueError('weights_path должен заканчиваться на .rknn')
        return v

    @validator('classes_path')
    def validate_classes_path(cls, v):
        if v is not None and not v.endswith('.json'):
            raise ValueError('classes_path должен заканчиваться на .json')
        return v


class LoaderResponse(LoaderBase):
    """Модель ответа с информацией о загрузчике"""
    status: str = Field(default="stopped", description="Статус: running, stopped, error")

    class Config:
        json_schema_extra = {
            "example": {
                "loader_name": "Loader_1",
                "weights_path": "/models/yolov5s.rknn",
                "classes_path": "/models/coco.json",
                "img_size": 640,
                "server_endpoint": "/neural_1",
                "loader_matrix": [["Camera_1", "Camera_2"]],
                "status": "running"
            }
        }


class LoaderStatus(LoaderResponse):
    """Детальный статус загрузчика"""
    fps: Optional[float] = Field(None, description="Текущий FPS")
    inference_time_ms: Optional[float] = Field(None, description="Среднее время инференса (мс)")
    batch_width: Optional[int] = Field(None, description="Ширина батча")
    batch_height: Optional[int] = Field(None, description="Высота батча")
    error_message: Optional[str] = Field(None, description="Сообщение об ошибке")
    uptime_seconds: Optional[int] = Field(None, description="Время работы в секундах")


class MatrixValidation(BaseModel):
    """Результат валидации матрицы"""
    valid: bool
    missing_cameras: List[str] = []
    duplicate_cameras: List[str] = []


class MatrixValidationRequest(BaseModel):
    """Запрос на валидацию матрицы"""
    loader_matrix: List[List[str]] = Field(..., min_items=1)
