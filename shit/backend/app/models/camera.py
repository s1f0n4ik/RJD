from pydantic import BaseModel, Field, validator
from typing import Optional
from datetime import datetime
import re


class CameraBase(BaseModel):
    """Базовая модель камеры"""
    camera_name: str = Field(..., min_length=1, max_length=50, description="Уникальное имя камеры")
    rtsp_url: str = Field(..., description="RTSP URL камеры")
    width: Optional[int] = Field(None, ge=320, le=3840, description="Ширина кадра")
    height: Optional[int] = Field(None, ge=240, le=2160, description="Высота кадра")
    reconnect_interval: int = Field(5, ge=1, le=60, description="Интервал переподключения (сек)")

    @validator('camera_name')
    def validate_camera_name(cls, v):
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError('camera_name должно содержать только буквы, цифры, _, -')
        return v

    @validator('rtsp_url')
    def validate_rtsp_url(cls, v):
        if not v.startswith('rtsp://'):
            raise ValueError('URL должен начинаться с rtsp://')
        return v


class CameraCreate(CameraBase):
    """Модель для создания камеры"""
    pass


class CameraUpdate(BaseModel):
    """Модель для обновления камеры"""
    rtsp_url: Optional[str] = None
    width: Optional[int] = Field(None, ge=320, le=3840)
    height: Optional[int] = Field(None, ge=240, le=2160)
    reconnect_interval: Optional[int] = Field(None, ge=1, le=60)

    @validator('rtsp_url')
    def validate_rtsp_url(cls, v):
        if v is not None and not v.startswith('rtsp://'):
            raise ValueError('URL должен начинаться с rtsp://')
        return v


class CameraResponse(CameraBase):
    """Модель ответа с информацией о камере"""
    status: str = Field(default="connecting", description="Статус: connecting, connected, disconnected, error")

    class Config:
        json_schema_extra = {
            "example": {
                "camera_name": "Camera_1",
                "rtsp_url": "rtsp://192.168.1.100:554/stream",
                "width": None,
                "height": None,
                "reconnect_interval": 5,
                "status": "connected"
            }
        }


class CameraStatus(CameraResponse):
    """Детальный статус камеры"""
    fps: Optional[float] = Field(None, description="Текущий FPS")
    last_frame_time: Optional[datetime] = Field(None, description="Время последнего кадра")
    error_message: Optional[str] = Field(None, description="Сообщение об ошибке")
    uptime_seconds: Optional[int] = Field(None, description="Время работы в секундах")