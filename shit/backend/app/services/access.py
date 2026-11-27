import re
from enum import Enum
from typing import Optional
from urllib.parse import unquote

from fastapi import Depends, HTTPException, Request
from starlette.requests import HTTPConnection

from app.services.auth import request_user

ENTRANCE_HEADER = "x-rjd-entrance"
LOOPBACK = "127.0.0.1"
DETAILS = {401: "Login required", 403: "Admin access required"}


class Access(str, Enum):
    PUBLIC = "public"
    ADMIN = "admin"
    LAN_FREE = "lan_free"
    ADMIN_OR_SERVICE = "admin_or_service"


def entrance(conn: HTTPConnection) -> str:
    # Вход «remote» ставит nginx на 127.0.0.1:8090; значение «remote» только ужесточает права, поэтому принимается от любого адреса
    return "remote" if conn.headers.get(ENTRANCE_HEADER) == "remote" else "lan"


def internal(conn: HTTPConnection) -> bool:
    # Служба самой машины: запрос с 127.0.0.1 мимо nginx, без заголовка входа
    peer = conn.client.host if conn.client else None
    return peer == LOOPBACK and ENTRANCE_HEADER not in conn.headers


def decide(access: Access, where: str, user: Optional[dict]) -> Optional[int]:
    # None — запрос пропускается, иначе код ответа 401 или 403
    if where == "lan" and access in (Access.PUBLIC, Access.LAN_FREE):
        return None
    if not user:
        return 401
    if access is Access.PUBLIC or user["role"] == "admin":
        return None
    return 403


def check(conn: HTTPConnection, access: Access) -> Optional[int]:
    if access is Access.ADMIN_OR_SERVICE and internal(conn):
        return None
    return decide(access, entrance(conn), request_user(conn))


def _guard(access: Access):
    async def guard(request: Request):
        status = check(request, access)
        if status:
            raise HTTPException(status_code=status, detail=DETAILS[status])
    guard.access = access
    return guard


PUBLIC = [Depends(_guard(Access.PUBLIC))]
ADMIN = [Depends(_guard(Access.ADMIN))]
LAN_FREE = [Depends(_guard(Access.LAN_FREE))]
ADMIN_OR_SERVICE = [Depends(_guard(Access.ADMIN_OR_SERVICE))]

_READ = {"GET", "HEAD"}
_ANY = None

# Пути вне маршрутов FastAPI: (методы или любой, шаблон, класс); решает первое совпадение, иначе администратор
_PATH_RULES = [
    (_READ, r"/d/[^/]+/mc/(camera|streams|system/info|linker/status|linker/view-mode|neural/status|neural/summary|neural/configurations|neural/classes|neural/superclasses)", Access.PUBLIC),
    ({"POST"}, r"/d/[^/]+/mc/linker/view-mode", Access.LAN_FREE),
    (_ANY, r"/d/[^/]+/storage/api/recordings/(jobs|merge|archive)(/.*)?", Access.ADMIN),
    (_READ, r"/d/[^/]+/storage/api/archive/(day|days|range|segments|shape|state|frame|file/[^/]+)", Access.PUBLIC),
    (_READ, r"/d/[^/]+/storage/api/recordings(/disk|/[^/]+|/(download|stream)/[^/]+/[^/]+)?", Access.PUBLIC),
    (_ANY, r"/d/[^/]+/signaling/.*", Access.PUBLIC),
    (_READ, r"/api/journal/(detections|detections/[^/]+|head|summary|settings|jobs|jobs/[^/]+/(download|progress)|frame/[^/]+\.jpg|image/[^/]+\.jpg|tiles/\d+/\d+/\d+\.pbf|map/style\.json|map/sprite/[^/]+|map/glyphs/[^/]+/[^/]+\.pbf)", Access.PUBLIC),
    ({"PATCH"}, r"/api/journal/detections/[^/]+/verdict", Access.PUBLIC),
    ({"POST"}, r"/api/journal/export", Access.PUBLIC),
    ({"DELETE"}, r"/api/journal/jobs/[^/]+", Access.PUBLIC),
    (_READ, r"/api/gateway/(status|time|ws/status|integrations/[^/]+/status)", Access.PUBLIC),
]
_COMPILED = [(methods, re.compile(pattern), access) for methods, pattern, access in _PATH_RULES]
_ENCODED_SEPARATOR = re.compile(r"%(2f|5c|2e)", re.IGNORECASE)


def path_access(method: str, path: str) -> Access:
    # Класс пути по таблице; пути с «..», «//» или закодированными разделителями — только администратору
    path = path.split("?", 1)[0]
    if _ENCODED_SEPARATOR.search(path):
        return Access.ADMIN
    decoded = unquote(path)
    if "//" in decoded or "\\" in decoded or ".." in decoded.split("/"):
        return Access.ADMIN
    method = method.upper()
    for methods, pattern, access in _COMPILED:
        if (methods is None or method in methods) and pattern.fullmatch(decoded):
            return access
    return Access.ADMIN


def check_path(conn: HTTPConnection, method: str, path: str) -> Optional[int]:
    return decide(path_access(method, path), entrance(conn), request_user(conn))
