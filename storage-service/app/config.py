from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Конфигурация storage-сервиса"""

    # Где лежат записи, стартовый путь. Меняется в рантайме через API.
    RECORDS_PATH: str = "/storage/internal"

    # Порог занятости диска с записями в процентах.
    # Когда занято больше этого значения — запускается очистка старых записей.
    # Записи используют весь диск, кроме этого запаса. 0 = очистка отключена.
    MAX_USED_PERCENT: float = 90.0

    # Как часто проверять место (секунды)
    CLEANUP_INTERVAL_SEC: int = 60

    # Гистерезис: при очистке освобождаем место с запасом, до порога * ratio.
    # Например, порог 90%, ratio 0.9 — чистим пока занятость не упадёт до 81%.
    # Чтобы не дёргать удаление на каждом цикле.
    CLEANUP_TARGET_RATIO: float = 0.9

    # Размер чанка при стриминге Range, байт
    STREAM_CHUNK_SIZE: int = 64 * 1024

    # Таймаут на склейку ffmpeg, секунды
    MERGE_TIMEOUT_SEC: int = 300

    # Через сколько секунд после отдачи файла на скачивание удалять его.
    # Не удаляем сразу, чтобы клиент успел дописать большой архив на диск.
    DOWNLOAD_CLEANUP_DELAY_SEC: int = 300

    # FastAPI
    APP_NAME: str = "Recordings Storage Service"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()