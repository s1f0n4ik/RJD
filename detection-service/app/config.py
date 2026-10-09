from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "detection-service"
    # Порт приёма потока от устройств
    GRPC_PORT: int = 50052

    # Журнал: база, кадры, последняя известная конфигурация шлюза
    JOURNAL_DIR: str = "/storage/journal"
    # REST шлюза АС КРСПС: активная конфигурация
    GATEWAY_URL: str = "http://127.0.0.1:9090"
    GATEWAY_POLL_SEC: float = 5.0
    # gRPC шлюза: обнаружения в АС КРСПС
    GATEWAY_GRPC: str = "127.0.0.1:50051"
    GATEWAY_RETRY_SEC: float = 2.0

    # Пакет, пролежавший в очереди устройства дольше, — опоздавший: только в журнал
    LATE_MS: int = 5000
    # Связь с устройством не вернулась за это время — его открытые обнаружения закрываются
    LINK_LOST_SEC: float = 10.0

    # РСМ-2000: пауза между пропажей трека и появлением нового, который сшивается с ним
    STITCH_GAP_MS: int = 2000
    # РСМ-2000: допустимое смещение центра нового трека в диагоналях последней рамки прежнего
    STITCH_DISTANCE: float = 1.0

    CLEANUP_INTERVAL_SEC: int = 60

    # Карта журнала: офлайн-тайлы и стиль MapLibre
    TILES_MBTILES: str = "/storage/journal/tiles/russia.mbtiles"
    MAP_DIR: str = "/storage/journal/map"

    # Выгрузки журнала: архив живёт до скачивания или до срока
    EXPORTS_DIR: str = "/storage/journal/exports"
    EXPORT_TTL_SEC: int = 6 * 3600
    DOWNLOAD_CLEANUP_DELAY_SEC: int = 300


settings = Settings()
