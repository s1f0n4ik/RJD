import asyncio
import importlib.util
import logging
import os
import stat
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
TMP = tempfile.mkdtemp(prefix="access-check-")
SECRET = Path(TMP) / "auth-secret"
os.environ.update({
    "DEBUG": "false", "AUTH_SECRET_FILE": str(SECRET), "DEVICES_FILE": f"{TMP}/devices.json",
    "CONFIG_DB": f"{TMP}/config.db", "CONFIG_ASSETS_DIR": f"{TMP}/assets",
    "UPDATE_MASTER_URL": "http://127.0.0.1:9", "DETECTION_URL": "http://127.0.0.1:9", "GATEWAY_URL": "http://127.0.0.1:9",
})

import httpx
from fastapi.routing import APIRoute
from jose import jwt

from app import main
from app.config import settings
from app.routers import device_proxy
from app.services import auth
from app.services.access import Access

logging.disable(logging.INFO)

NGINX = "127.0.0.1"
LAN_HOST = "192.168.1.50"
DENIED = (401, 403)
ADMIN_TOKEN = auth.create_access_token({"sub": "admin", "role": "admin"})
VIEWER_TOKEN = auth.create_access_token({"sub": "user", "role": "viewer"})


# Вход и роль одного запроса: адрес собеседника, заголовок nginx, cookie сессии
class Caller:
    def __init__(self, name, peer, entrance=None, token=None, bearer=False):
        self.name, self.peer, self.entrance, self.token, self.bearer = name, peer, entrance, token, bearer

    def headers(self, extra=None):
        headers = dict(extra or {})
        if self.entrance:
            headers["X-RJD-Entrance"] = self.entrance
        if self.token and self.bearer:
            headers["Authorization"] = f"Bearer {self.token}"
        elif self.token:
            headers["Cookie"] = f"{auth.SESSION_COOKIE}={self.token}"
        return headers

    async def request(self, method, path, **kwargs):
        transport = httpx.ASGITransport(app=main.app, client=(self.peer, 50000), raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://machine") as client:
            headers = self.headers(kwargs.pop("headers", None))
            return await asyncio.wait_for(client.request(method, path, headers=headers, **kwargs), 20)

    async def websocket(self, path):
        # Рукопожатие WebSocket прямо в ASGI: accept или код закрытия до него
        headers = [(k.lower().encode(), v.encode()) for k, v in self.headers().items()]
        scope = {"type": "websocket", "path": path, "raw_path": path.encode(), "query_string": b"", "headers": headers,
                 "client": (self.peer, 50000), "server": ("machine", 80), "scheme": "ws", "subprotocols": [],
                 "asgi": {"version": "3.0"}, "root_path": ""}
        inbox = asyncio.Queue()
        await inbox.put({"type": "websocket.connect"})
        sent = []

        async def receive():
            if sent:
                return {"type": "websocket.disconnect", "code": 1000}
            return await inbox.get()

        async def send(message):
            sent.append(message)

        await asyncio.wait_for(main.app(scope, receive, send), 20)
        first = sent[0]
        return "accept" if first["type"] == "websocket.accept" else first.get("code")


LAN_ANON = Caller("ЛВС без входа", NGINX, "lan")
LAN_VIEWER = Caller("ЛВС наблюдатель", NGINX, "lan", VIEWER_TOKEN)
LAN_ADMIN = Caller("ЛВС администратор", NGINX, "lan", ADMIN_TOKEN)
REMOTE_ANON = Caller("удалённо без входа", NGINX, "remote")
REMOTE_VIEWER = Caller("удалённо наблюдатель", NGINX, "remote", VIEWER_TOKEN)
REMOTE_ADMIN = Caller("удалённо администратор", NGINX, "remote", ADMIN_TOKEN)
REMOTE_BEARER = Caller("удалённо администратор по Bearer", NGINX, "remote", ADMIN_TOKEN, bearer=True)
CALLERS = (LAN_ANON, LAN_VIEWER, LAN_ADMIN, REMOTE_ANON, REMOTE_VIEWER, REMOTE_ADMIN, REMOTE_BEARER)

# Ожидание по классу из machine-access.md: None — пропуск, иначе код отказа
EXPECTED = {
    Access.PUBLIC: {LAN_ANON: None, LAN_VIEWER: None, LAN_ADMIN: None, REMOTE_ANON: 401, REMOTE_VIEWER: None, REMOTE_ADMIN: None, REMOTE_BEARER: None},
    Access.ADMIN: {LAN_ANON: 401, LAN_VIEWER: 403, LAN_ADMIN: None, REMOTE_ANON: 401, REMOTE_VIEWER: 403, REMOTE_ADMIN: None, REMOTE_BEARER: None},
    Access.LAN_FREE: {LAN_ANON: None, LAN_VIEWER: None, LAN_ADMIN: None, REMOTE_ANON: 401, REMOTE_VIEWER: 403, REMOTE_ADMIN: None, REMOTE_BEARER: None},
}

# По одному-два маршрута каждого класса и сервиса; тела заведомо неверные, чтобы пропущенный запрос не менял данных
HTTP_CASES = [
    (Access.PUBLIC, "GET", "/api/devices", {}),
    (Access.PUBLIC, "GET", "/api/layouts", {}),
    (Access.PUBLIC, "GET", "/api/configurations/link", {}),
    (Access.PUBLIC, "GET", "/api/update/lock", {}),
    (Access.LAN_FREE, "POST", "/api/layouts", {"json": {}}),
    (Access.LAN_FREE, "DELETE", "/api/layouts/check?context=none", {}),
    (Access.ADMIN, "GET", "/api/devices/routing", {}),
    (Access.ADMIN, "POST", "/api/devices", {"json": {}}),
    (Access.ADMIN, "PUT", "/api/time/config", {"json": {}}),
    (Access.ADMIN, "GET", "/api/update/state", {}),
    (Access.PUBLIC, "GET", "/d/dev1/mc/camera", {}),
    (Access.PUBLIC, "GET", "/d/dev1/mc/neural/classes?config_id=x", {}),
    (Access.LAN_FREE, "POST", "/d/dev1/mc/linker/view-mode", {"json": {}}),
    (Access.ADMIN, "POST", "/d/dev1/mc/camera", {"json": {}}),
    (Access.ADMIN, "GET", "/d/dev1/mc/config", {}),
    (Access.PUBLIC, "GET", "/d/dev1/storage/api/archive/day?date=2026-11-25", {}),
    (Access.PUBLIC, "GET", "/d/dev1/storage/api/recordings/cam1", {}),
    (Access.ADMIN, "GET", "/d/dev1/storage/api/recordings/jobs", {}),
    (Access.ADMIN, "GET", "/d/dev1/storage/api/archive/zip", {}),
    (Access.ADMIN, "GET", "/d/dev1/storage/api/storage/pool", {}),
]

# Службы вне FastAPI через auth_request nginx: исходный метод и адрес
NGINX_CASES = [
    (Access.PUBLIC, "GET", "/api/journal/detections?limit=50"),
    (Access.PUBLIC, "GET", "/api/journal/frame/12.jpg"),
    (Access.PUBLIC, "GET", "/api/journal/settings"),
    (Access.PUBLIC, "PATCH", "/api/journal/detections/12/verdict"),
    (Access.PUBLIC, "POST", "/api/journal/export"),
    (Access.PUBLIC, "GET", "/api/journal/jobs/a1/progress"),
    (Access.ADMIN, "POST", "/api/journal/settings"),
    (Access.ADMIN, "POST", "/api/journal/purge"),
    (Access.PUBLIC, "GET", "/api/gateway/status"),
    (Access.PUBLIC, "GET", "/api/gateway/integrations/kzt/status"),
    (Access.ADMIN, "PUT", "/api/gateway/config"),
    (Access.ADMIN, "POST", "/api/gateway/modules/connect"),
    (Access.ADMIN, "GET", "/api/scan/cameras"),
    (Access.ADMIN, "GET", "/api/journal/%2e%2e/scan/cameras"),
    (Access.ADMIN, "GET", "/api/journal/detections/../../scan/cameras"),
]

WS_CASES = [
    (Access.PUBLIC, "/ws"),
    (Access.PUBLIC, "/d/dev1/signaling/ws"),
    (Access.ADMIN, "/d/dev1/storage/api/recordings/jobs/j1/progress"),
]


def outcome(code):
    return code if code in DENIED else None


async def matrix():
    failures = []
    for access, method, path, kwargs in HTTP_CASES:
        for caller in CALLERS:
            response = await caller.request(method, path, **kwargs)
            if outcome(response.status_code) != EXPECTED[access][caller]:
                failures.append(f"{method} {path} [{access.value}] {caller.name}: {response.status_code} {response.text[:80]}")
    for access, method, uri in NGINX_CASES:
        for caller in CALLERS:
            response = await caller.request("GET", "/auth/check", headers={"X-Original-Method": method, "X-Original-URI": uri})
            want = EXPECTED[access][caller]
            if (want or 204) != response.status_code:
                failures.append(f"auth_request {method} {uri} [{access.value}] {caller.name}: {response.status_code}")
    for access, path in WS_CASES:
        for caller in CALLERS:
            want = EXPECTED[access][caller]
            got = await caller.websocket(path)
            if got != (4000 + want if want else "accept") and not (want is None and got == 4404):
                failures.append(f"WS {path} [{access.value}] {caller.name}: {got}")
    assert not failures, "\n".join(failures)
    return len(HTTP_CASES) + len(NGINX_CASES) + len(WS_CASES)


async def entrances():
    # Вход определяется только по адресу nginx и его заголовку
    async def policy(caller):
        return (await caller.request("GET", "/auth/policy")).json()

    assert await policy(LAN_ANON) == {"entrance": "lan", "login_required": False}
    assert await policy(REMOTE_ANON) == {"entrance": "remote", "login_required": True}
    assert await policy(Caller("ЛВС напрямую на :8000", LAN_HOST)) == {"entrance": "lan", "login_required": False}
    # Заголовок «remote» от любого адреса только ужесточает права
    stricter = Caller("ЛВС напрямую с заголовком remote", LAN_HOST, "remote")
    assert await policy(stricter) == {"entrance": "remote", "login_required": True}
    assert (await stricter.request("GET", "/api/devices")).status_code == 401
    forged = Caller("ЛВС напрямую с заголовком lan", LAN_HOST, "lan")
    assert (await forged.request("GET", "/api/devices/routing")).status_code == 401
    assert await policy(Caller("служба мастера без заголовка", NGINX)) == {"entrance": "lan", "login_required": False}

    # Прежний update-master без токена: после установки части мастера читает состояние и снимок запуска
    service = Caller("служба мастера без токена", NGINX)
    for path in ("/api/config/status", "/api/config/runtime"):
        assert (await service.request("GET", path)).status_code == 200, path
        assert (await LAN_ANON.request("GET", path)).status_code == 401, path
        assert (await Caller("ЛВС напрямую", LAN_HOST).request("GET", path)).status_code == 401, path
        assert (await REMOTE_ANON.request("GET", path)).status_code == 401, path
        assert (await LAN_VIEWER.request("GET", path)).status_code == 403, path
        assert (await LAN_ADMIN.request("GET", path)).status_code == 200, path
    assert (await service.request("GET", "/api/config/effective")).status_code == 401
    assert (await service.request("POST", "/api/config/active", json={})).status_code == 401
    assert (await service.request("GET", "/api/devices/routing")).status_code == 401


async def tokens():
    # Чужой секрет, старый зашитый секрет и испорченная подпись — 401 на администраторском маршруте
    claims = {"sub": "admin", "role": "admin", "exp": 4102444800}
    for name, token in (("чужая машина", jwt.encode(claims, b"x" * 32, algorithm="HS256")),
                        ("старый секрет", jwt.encode(claims, "Aboba228822", algorithm="HS256")),
                        ("испорченная подпись", ADMIN_TOKEN[:-4] + "AAAA")):
        for caller in (Caller(name, NGINX, "lan", token), Caller(name, NGINX, "remote", token, bearer=True)):
            response = await caller.request("GET", "/api/devices/routing")
            assert response.status_code == 401, (name, caller.entrance, response.status_code)
        assert (await Caller(name, NGINX, "remote", token).request("GET", "/api/devices")).status_code == 401
        assert (await Caller(name, NGINX, "lan", token).request("GET", "/api/devices")).status_code == 200

    # Токен службы обновлений подписан тем же секретом и принимается как администратор
    spec = importlib.util.spec_from_file_location("updater_common", ROOT.parents[1] / "updater" / "app" / "common.py")
    common = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = common
    spec.loader.exec_module(common)
    service = common.backend_token(SECRET)
    assert (await Caller("update-master", NGINX, token=service, bearer=True).request("GET", "/api/devices/routing")).status_code == 200
    assert common.backend_token(Path(TMP) / "missing") is None


async def sessions():
    # Вход ставит cookie сессии с нужными атрибутами, выход её стирает
    for caller, secure in ((LAN_ANON, False), (REMOTE_ANON, True)):
        response = await caller.request("POST", "/auth/viewer")
        assert response.status_code == 200 and response.json()["role"] == "viewer"
        cookie = response.headers["set-cookie"]
        parts = {p.strip().split("=")[0].lower() for p in cookie.split(";")}
        assert cookie.startswith(f"{auth.SESSION_COOKIE}={response.json()['access_token']};"), cookie
        assert {"httponly", "path", "max-age", "samesite"} <= parts and "samesite=strict" in cookie.lower(), cookie
        assert ("secure" in parts) == secure, cookie
        viewer = Caller("наблюдатель по выданной cookie", NGINX, caller.entrance, response.json()["access_token"])
        assert (await viewer.request("GET", "/api/devices")).status_code == 200
        assert (await viewer.request("GET", "/api/devices/routing")).status_code == 403
        out = await caller.request("POST", "/auth/logout")
        assert out.status_code == 204 and "max-age=0" in out.headers["set-cookie"].lower(), out.headers
    assert (await REMOTE_ANON.request("POST", "/auth/login", json={"username": "admin", "password": "wrong"})).status_code == 401
    assert (await REMOTE_ADMIN.request("GET", "/auth/me")).json() == {"username": "admin", "role": "admin"}
    assert (await REMOTE_ANON.request("GET", "/auth/me")).status_code == 401
    # Неверный Bearer не перекрывает действующую cookie сессии
    stale = {"Authorization": "Bearer null", "Cookie": f"{auth.SESSION_COOKIE}={ADMIN_TOKEN}"}
    assert (await LAN_ANON.request("GET", "/api/devices/routing", headers=stale)).status_code == 200


async def leaks():
    # На плату через прокси не уходят cookie, токен и заголовок входа; CORS не разрешает cookie чужому источнику
    seen = []

    class Echo(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append({k.lower(): v for k, v in self.headers.items()})
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with patch.object(settings, "DEVICE_MC_PORT", server.server_address[1]), \
             patch.object(device_proxy.registry, "get", lambda device_id: {"id": device_id, "ip": "127.0.0.1"}):
            response = await LAN_ADMIN.request("GET", "/d/dev1/mc/camera", headers={"Authorization": f"Bearer {ADMIN_TOKEN}"})
    finally:
        server.shutdown()
    assert response.status_code == 200 and seen, response.status_code
    assert not {"cookie", "authorization", "x-rjd-entrance"} & set(seen[0]), seen[0]

    response = await LAN_ADMIN.request("GET", "/api/devices", headers={"Origin": "http://other.example"})
    assert response.headers.get("access-control-allow-credentials") is None, response.headers


def every_route():
    # У каждого маршрута FastAPI есть класс доступа; без него только вход, прокси устройств и проверка здоровья
    bare = []
    for route in main.app.routes:
        if not isinstance(route, APIRoute):
            continue
        found = [d.call.access for d in route.dependant.dependencies if hasattr(d.call, "access")]
        if len(found) != 1 and not route.path.startswith(("/auth/", "/d/")) and route.path not in ("/", "/health"):
            bare.append((sorted(route.methods), route.path, found))
    assert not bare, bare


def secret_file():
    # Секрет создаётся случайным, 32 байта, 0600, и переживает перезапуск; испорченный файл заменяется
    value = SECRET.read_bytes()
    assert len(value) == 32 and value != b"\0" * 32
    if os.name != "nt":
        assert stat.S_IMODE(SECRET.stat().st_mode) == 0o600
    auth._secret = None
    assert auth.load_secret() == value
    SECRET.write_bytes(b"short")
    auth._secret = None
    assert len(auth.load_secret()) == 32 and auth.load_secret() != value
    assert auth.decode_token(ADMIN_TOKEN) is None


every_route()
count = asyncio.run(matrix())
asyncio.run(entrances())
asyncio.run(tokens())
asyncio.run(sessions())
asyncio.run(leaks())
secret_file()
print(f"access-check: OK ({count} routes x {len(CALLERS)} callers, entrances, service reads, tokens, cookies, proxy headers, CORS, secret)")
