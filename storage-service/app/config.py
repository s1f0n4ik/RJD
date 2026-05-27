from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Конфигурация storage-сервиса"""

    # Где лежат записи
    RECORDS_PATH: str = "/storage/internal"

    # Лимит занимаемого места корневым каталогом, в гигабайтах.
    # 0 = безлимитно (очистка отключена).
    MAX_STORAGE_GB: float = 0

    # Как часто проверять место (секунды)
    CLEANUP_INTERVAL_SEC: int = 60

    # «Запас» при очистке: чистим до этого порога от лимита.
    # Например, лимит 100ГБ, цель 90% — освобождаем до 90ГБ.
    # Чтобы не дёргать очистку постоянно при каждом новом файле.
    CLEANUP_TARGET_RATIO: float = 0.9

    # Размер чанка при стриминге Range, байт
    STREAM_CHUNK_SIZE: int = 64 * 1024

    # Таймаут на склейку ffmpeg, секунды
    MERGE_TIMEOUT_SEC: int = 300

    # FastAPI
    APP_NAME: str = "Recordings Storage Service"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()