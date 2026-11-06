from __future__ import annotations

import http.client
import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)
CHUNK = 1 << 20
# Прокси из окружения платы не должен перехватывать запросы к соседним платам
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# Адресат не ответил: нет связи, отказ соединения, обрыв
class Unreachable(Exception):
    pass


class Cancelled(Exception):
    pass


class Request:
    def __init__(self, handler: BaseHTTPRequestHandler):
        self._handler = handler
        parsed = urllib.parse.urlsplit(handler.path)
        self.method = handler.command
        self.path = parsed.path
        self.query = dict(urllib.parse.parse_qsl(parsed.query))
        self.headers = handler.headers
        self.client = handler.client_address[0]
        try:
            self.length = int(handler.headers.get("Content-Length") or 0)
        except ValueError:
            self.length = -1
        self.left = max(self.length, 0)

    def read(self, size: int = -1) -> bytes:
        if self.left <= 0:
            return b""
        size = self.left if size < 0 else min(size, self.left)
        data = self._handler.rfile.read(size)
        if not data:
            raise HttpError(400, "Request body ended early")
        self.left -= len(data)
        return data

    def json(self) -> dict:
        try:
            value = json.loads(self.read() or b"{}")
        except ValueError:
            raise HttpError(400, "Invalid JSON body") from None
        if not isinstance(value, dict):
            raise HttpError(400, "JSON object expected")
        return value


Routes = dict[tuple[str, str], Callable[[Request], object]]


def serve(routes: Routes, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def dispatch(self) -> None:
            request = Request(self)
            handler = routes.get((self.command, request.path))
            try:
                if handler is None:
                    raise HttpError(404, f"No route {self.command} {request.path}")
                status, body = 200, handler(request)
            except HttpError as e:
                status, body = e.status, {"error": str(e)}
            except Exception as e:
                logger.exception(f"{self.command} {request.path} failed")
                status, body = 500, {"error": str(e)}
            # Непрочитанное тело ломает следующий запрос в том же соединении
            if request.left > 0:
                self.close_connection = True
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                if self.close_connection:
                    self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)
            except OSError as e:
                # Клиент ушёл раньше ответа: отмена доставки или обрыв связи
                logger.debug(f"Client left before the response to {self.command} {request.path}: {e}")
                self.close_connection = True

        do_GET = do_PUT = do_POST = do_DELETE = dispatch

        def log_message(self, format: str, *args) -> None:
            logger.debug(format % args)

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        # Очередь входящих соединений: при переполнении подключение сбрасывается
        request_queue_size = 64

    return Server((host, port), Handler)


def _error_text(body: bytes) -> str:
    try:
        return str(json.loads(body).get("error") or body.decode("utf-8", "replace"))
    except (ValueError, AttributeError):
        return body.decode("utf-8", "replace")[:300]


def call(method: str, url: str, body: dict | None = None, timeout: float = 5) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with _opener.open(request, timeout=timeout) as response:
            value = json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise HttpError(e.code, _error_text(e.read())) from None
    except (OSError, ValueError, http.client.HTTPException) as e:
        raise Unreachable(str(getattr(e, "reason", e))) from None
    return value if isinstance(value, dict) else {}


def put_file(url: str, path: Path, progress: Callable[[int], None], stop: threading.Event, timeout: float = 60) -> dict:
    parts = urllib.parse.urlsplit(url)
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=timeout)
    try:
        conn.putrequest("PUT", parts.path + (f"?{parts.query}" if parts.query else ""))
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(path.stat().st_size))
        conn.endheaders()
        with path.open("rb") as f:
            while chunk := f.read(CHUNK):
                if stop.is_set():
                    raise Cancelled()
                conn.send(chunk)
                progress(len(chunk))
        response = conn.getresponse()
        body = response.read()
    except (OSError, http.client.HTTPException) as e:
        raise Unreachable(str(e)) from None
    finally:
        conn.close()
    if response.status >= 400:
        raise HttpError(response.status, _error_text(body))
    return json.loads(body or b"{}")
