from pydantic import BaseModel
from typing import Optional, List

class CPPCameraStream(BaseModel):
    """Поток камеры (main/sub) в формате C++"""
    type_url: int  # 1-Hikvision, 2-Dahua, 3-ACE, 4-Beward
    username: str
    password: str
    record_path: Optional[str] = None  # Только для main
    length: Optional[int] = None  # Только для main
    delete_delay: Optional[int] = None  # Только для main
    use_udp: bool = False
    status: Optional[int] = None  # 0-нет, 1-готов, 2-остановлен, 3-в работе

class CPPCamera(BaseModel):
    """Формат камеры C++ Media Center"""
    name: str
    description: str
    main: CPPCameraStream
    sub: CPPCameraStream
    reconnect: int

class CPPCameraResponse(BaseModel):
    """Ответ C++ API"""
    ret: int  # 0-ошибка, 1-успех
    description: str
    camera: Optional[CPPCamera] = None

class CPPCamerasResponse(BaseModel):
    """Список камер C++"""
    ret: int
    description: str
    cameras: Optional[List[CPPCamera]] = None