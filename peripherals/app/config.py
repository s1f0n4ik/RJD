from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "peripherals"
    APP_VERSION: str = "0.1.0"
    HTTP_PORT: int = 8006
    GRPC_PORT: int = 50053
    GATEWAY_GRPC: str = "127.0.0.1:50051"
    GATEWAY_POLL_SEC: float = 5.0
    STATE_FILE: str = "/data/peripherals-state.json"


settings = Settings()
