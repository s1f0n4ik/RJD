import asyncio
import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

os.environ["DEBUG"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI

# В venv проверок FastAPI новее, чем в образе: старого имени метода там нет
if not hasattr(FastAPI, "add_websocket_route"):
    FastAPI.add_websocket_route = FastAPI.add_api_websocket_route

from app import main
from app.config import settings
from app.services import system_update
from app.services.auth import create_access_token


class FakeUpdater:
    # update-master на хосте: запоминает, что к нему пришло
    def __init__(self):
        self.busy = False
        self.refuse_start = False
        self.requests = []

        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle_one(self):
                parts = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                digest, size = hashlib.sha256(), 0
                while size < length:
                    chunk = self.rfile.read(min(1 << 16, length - size))
                    digest.update(chunk)
                    size += len(chunk)
                owner.requests.append({"method": self.command, "path": parts.path, "query": dict(parse_qsl(parts.query)),
                                       "size": size, "sha": digest.hexdigest(), "headers": dict(self.headers)})
                status, body = 200, {"ok": True, "path": parts.path}
                if parts.path == "/lock":
                    body = {"busy": owner.busy, "phase": "install" if owner.busy else None, "kind": "update"}
                elif parts.path == "/start" and owner.refuse_start:
                    status, body = 409, {"error": "Pre-start checks failed"}
                elif parts.path == "/file":
                    body = {"size": size, "sha": digest.hexdigest()}
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_PUT = do_POST = do_DELETE = handle_one

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"


async def run() -> None:
    fake = FakeUpdater()
    settings.UPDATE_MASTER_URL = fake.url
    system_update._client = None
    admin = {"Authorization": f"Bearer {create_access_token({'sub': 'admin'})}"}
    viewer = {"Authorization": f"Bearer {create_access_token({'sub': 'user'})}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://master") as api:
        # Ход обновления для плашки открыт всем, остальное только администратору
        assert (await api.get("/api/update/lock")).json() == {"busy": False, "phase": None, "kind": "update"}
        assert (await api.get("/api/update/state")).status_code in (401, 403)
        assert (await api.get("/api/update/state", headers=viewer)).status_code == 403
        assert (await api.get("/api/update/state", headers=admin)).json()["path"] == "/state"

        # Файл уходит в службу потоком с длиной и именем, байт в байт
        data = os.urandom(3 * 1024 * 1024 + 5)

        async def body():
            for start in range(0, len(data), 256 * 1024):
                yield data[start:start + 256 * 1024]

        response = await api.put("/api/update/file", content=body(),
                                 headers={**admin, "Content-Length": str(len(data)), "X-File-Name": "varan-update-x.tar"})
        assert response.json() == {"size": len(data), "sha": hashlib.sha256(data).hexdigest()}, response.text
        sent = fake.requests[-1]
        assert sent["headers"].get("Content-Length") == str(len(data)) and "Transfer-Encoding" not in sent["headers"], sent["headers"]
        assert sent["headers"].get("X-File-Name") == "varan-update-x.tar"

        # Отказ службы доходит до экрана с её текстом и кодом
        fake.refuse_start = True
        refused = await api.post("/api/update/start", json={"confirm": True}, headers=admin)
        assert refused.status_code == 409 and refused.json()["detail"] == "Pre-start checks failed", refused.text
        assert fake.requests[-1]["path"] == "/start"
        assert (await api.get("/api/update/board-log", params={"id": "b2"}, headers=admin)).status_code == 200
        assert fake.requests[-1]["query"] == {"id": "b2"}

        # Во время обновления записи через API отвергаются, чтение и ручки обновления работают
        fake.busy = True
        locked = await api.put("/api/config/profiles/p/passport", json={"context": "c", "revision": "r", "changes": []})
        assert locked.status_code == 409 and locked.json()["detail"] == "System update is running", locked.text
        assert (await api.post("/api/config/active", json={"profile_id": "p"})).status_code == 409
        assert (await api.post("/api/update/cancel", headers=admin)).status_code == 200
        assert (await api.get("/api/update/lock")).json()["phase"] == "install"
        fake.busy = False

        # Служба не установлена: обновление не идёт, записи не блокируются, экран получает 502
        fake.server.shutdown()
        fake.server.server_close()
        await system_update.client().aclose()
        system_update._client = None
        assert (await api.get("/api/update/lock")).json()["busy"] is False
        assert (await api.get("/api/update/state", headers=admin)).status_code == 502
    print("system-update-check: OK")


asyncio.run(run())
