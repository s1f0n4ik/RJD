from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    """Конфигурация приложения"""

    # FastAPI settings
    APP_NAME: str = "Video Processor API"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True

    # Media Center (C++)
    MEDIA_CENTER_URL: str = "http://192.168.1.2:7777"
    MEDIA_CENTER_TIMEOUT: int = 10

    # Flask integration
    FLASK_BASE_URL: str = "http://localhost:5000"
    FLASK_TIMEOUT: int = 30

    # WebSocket
    WS_HEARTBEAT_INTERVAL: int = 30
    WS_BROADCAST_INTERVAL: float = 1.0

    # Loaders constraints
    MAX_LOADERS: int = 3
    AVAILABLE_ENDPOINTS: list = ["/neural_1", "/neural_2", "/neural_3"]

    # Models
    MODELS_PATH: str = "./models"

    # CORS
    CORS_ORIGINS: list = [
        "http://localhost:3000",
        "http://localhost",
        "http://192.168.1.2:3000",
        "http://192.168.1.2",
    ]

    class Config:
        env_file = ".env"
        case_sensitive = True

settings = Settings()