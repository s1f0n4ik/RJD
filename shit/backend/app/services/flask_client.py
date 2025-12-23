import httpx
import logging
from typing import Optional, Dict, Any, List
from app.config import settings

logger = logging.getLogger(__name__)


class FlaskClientError(Exception):
    """Ошибка при взаимодействии с Flask"""
    pass


async def _make_request(
        endpoint: str,
        method: str = "GET",
        data: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Выполнить HTTP запрос к Flask серверу

    Args:
        endpoint: Путь endpoint (например, /api/cameras)
        method: HTTP метод (GET, POST, DELETE)
        data: JSON данные для POST запросов

    Returns:
        Dict с ответом от Flask

    Raises:
        FlaskClientError: При ошибках подключения или HTTP ошибках
    """
    url = f"{settings.FLASK_BASE_URL}{endpoint}"

    try:
        async with httpx.AsyncClient(timeout=settings.FLASK_TIMEOUT) as client:
            logger.debug(f"Flask request: {method} {url}")

            if method == "GET":
                response = await client.get(url)
            elif method == "POST":
                response = await client.post(url, json=data)
            elif method == "DELETE":
                response = await client.delete(url)
            elif method == "PUT":
                response = await client.put(url, json=data)
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")

            response.raise_for_status()

            # Для DELETE может не быть body
            if response.status_code == 204:
                return {"status": "success"}

            return response.json()

    except httpx.TimeoutException as e:
        logger.error(f"Flask timeout: {url}")
        raise FlaskClientError(f"Flask server timeout: {endpoint}") from e

    except httpx.HTTPStatusError as e:
        logger.error(f"Flask HTTP error: {e.response.status_code} - {e.response.text}")
        raise FlaskClientError(
            f"Flask server error ({e.response.status_code}): {e.response.text}"
        ) from e

    except httpx.RequestError as e:
        logger.error(f"Flask connection error: {str(e)}")
        raise FlaskClientError(f"Flask server unavailable: {str(e)}") from e


# ============ Cameras ============

async def get_all_cameras() -> List[Dict[str, Any]]:
    """Получить список всех камер из Flask"""
    return await _make_request("/api/cameras", method="GET")


async def add_camera(camera_data: Dict[str, Any]) -> Dict[str, Any]:
    """Добавить камеру в Flask"""
    return await _make_request("/api/camera/add", method="POST", data=camera_data)


async def get_camera_status(camera_name: str) -> Dict[str, Any]:
    """Получить статус камеры из Flask"""
    return await _make_request(f"/api/camera/status/{camera_name}", method="GET")


async def update_camera(camera_name: str, camera_data: Dict[str, Any]) -> Dict[str, Any]:
    """Обновить камеру в Flask"""
    return await _make_request(
        f"/api/camera/update/{camera_name}",
        method="PUT",
        data=camera_data
    )


async def delete_camera(camera_name: str) -> Dict[str, Any]:
    """Удалить камеру из Flask"""
    return await _make_request(f"/api/camera/delete/{camera_name}", method="DELETE")


# ============ Loaders ============

async def get_all_loaders() -> List[Dict[str, Any]]:
    """Получить список всех загрузчиков из Flask"""
    return await _make_request("/api/loaders", method="GET")


async def create_loader(loader_data: Dict[str, Any]) -> Dict[str, Any]:
    """Создать загрузчик в Flask"""
    return await _make_request("/api/loader/create", method="POST", data=loader_data)


async def get_loader_status(loader_name: str) -> Dict[str, Any]:
    """Получить статус загрузчика из Flask"""
    return await _make_request(f"/api/loader/status/{loader_name}", method="GET")


async def update_loader(loader_name: str, loader_data: Dict[str, Any]) -> Dict[str, Any]:
    """Обновить загрузчик в Flask"""
    return await _make_request(
        f"/api/loader/update/{loader_name}",
        method="PUT",
        data=loader_data
    )


async def start_loader(loader_name: str) -> Dict[str, Any]:
    """Запустить загрузчик в Flask"""
    return await _make_request(f"/api/loader/start/{loader_name}", method="POST")


async def stop_loader(loader_name: str) -> Dict[str, Any]:
    """Остановить загрузчик в Flask"""
    return await _make_request(f"/api/loader/stop/{loader_name}", method="POST")


async def delete_loader(loader_name: str) -> Dict[str, Any]:
    """Удалить загрузчик из Flask"""
    return await _make_request(f"/api/loader/delete/{loader_name}", method="DELETE")


# ============ Health Check ============

async def check_flask_health() -> bool:
    """Проверить доступность Flask сервера"""
    try:
        await _make_request("/health", method="GET")
        return True
    except FlaskClientError:
        return False