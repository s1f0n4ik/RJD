import asyncio
import json
import logging
import time
import websockets
from urllib.parse import unquote
from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError
from websockets.asyncio.server import serve
from datetime import datetime, timezone

# ─────────────────────────────────────────
#  Logging
# ─────────────────────────────────────────

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s.%(msecs)03d  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("broker")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# ─────────────────────────────────────────
#  State
# ─────────────────────────────────────────

# camera_id -> {"camera": ws | None, "client": ws | None}
camera_pairs: dict[str, dict] = {}

# calibrator_id -> {"calibrator": ws|None, "client": ws|None, "client_name": str|None, "client_remote": tuple|None, "client_since": float|None}
calibrator_pairs: dict[str, dict] = {}

# Single lock — all state mutations go through it
_lock = asyncio.Lock()


# ─────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────

async def _safe_close(ws, reason: str = "peer disconnected") -> None:
    if ws is None:
        return
    try:
        await ws.close(1001, reason)
    except Exception:
        pass


# Error codes of the signaling transport. Range 1xxx belongs to the broker,
# the rest is emitted by media-center. Human readable texts live in the web
# interface, here we only send the number and service details.
ERR_CAMERA_NOT_CONNECTED = 1001
ERR_CAMERA_SEND_FAILED = 1002
ERR_CAMERA_GONE = 1003
ERR_CAMERA_REPLACED = 1004
ERR_CALIBRATOR_NOT_CONNECTED = 1005
ERR_CALIBRATOR_BUSY = 1006
ERR_CALIBRATOR_TAKEN_OVER = 1007

# Сколько брокер ждёт ответа клиента на вопрос о перехвате сессии
TAKEOVER_TIMEOUT_SEC = 30


def _message_type(message) -> str | None:
    """Message type of a text frame; binary and broken frames give None."""
    if isinstance(message, (bytes, bytearray)):
        return None
    try:
        parsed = json.loads(message)
        if isinstance(parsed, dict):
            kind = parsed.get("type")
            return kind if isinstance(kind, str) else None
    except (json.JSONDecodeError, ValueError):
        pass
    return None


async def _send_error(ws, kind: str, camera_id: str, client_id: str | None,
                      code: int, description: str) -> None:
    """Answer the client with a coded failure instead of dropping in silence."""
    if ws is None:
        return
    payload = json.dumps({
        "type": kind,
        "ret": "fault",
        "code": code,
        "camera": camera_id,
        "client_id": client_id,
        "description": description,
        "sender": "signaling",
        "timestamp": _now(),
    })
    try:
        await ws.send(payload)
    except Exception as exc:
        log.error("[BROKER] error reply failed  camera=%s  code=%s  error=%s",
                  camera_id, code, exc)


def _query_value(query: str, key: str) -> str | None:
    # Клиенты ходят через прокси шлюза, поэтому имя приходит строкой запроса
    for pair in query.split("&"):
        name, _, value = pair.partition("=")
        if name == key and value:
            return unquote(value)
    return None


def _fmt_remote(remote) -> str | None:
    # remote_address приходит кортежем (host, port)
    if remote is None:
        return None
    if isinstance(remote, (tuple, list)) and remote:
        return str(remote[0])
    return str(remote)


async def _send_session_message(ws, kind: str, meta: dict, ret="none") -> bool:
    # Служебное сообщение брокера клиенту калибратора в конверте протокола
    if ws is None:
        return False
    payload = json.dumps({
        "type": kind,
        "client_id": "broker",
        "camera": None,
        "meta": meta,
        "ret": ret,
        "sender": "signaling",
        "timestamp": _now(),
    })
    try:
        await ws.send(payload)
        return True
    except Exception as exc:
        log.error("[CAL-CLIENT] session message failed  type=%s  error=%s", kind, exc)
        return False


def _msg_size(message) -> str:
    if isinstance(message, (bytes, bytearray)):
        return f"{len(message)} bytes (binary)"
    return f"{len(message)} chars (text)"


# ─────────────────────────────────────────
#  Camera handlers
# ─────────────────────────────────────────

async def handle_camera(camera_id: str, websocket) -> None:
    log.info("[CAMERA] connected  id=%s  remote=%s", camera_id, websocket.remote_address)

    async with _lock:
        pair = camera_pairs.setdefault(camera_id, {"camera": None, "clients": {}})

        if pair["camera"] is not None:
            # Только тут вытеснение всё ещё имеет смысл: камера одна.
            log.warning("[CAMERA] replacing existing camera connection  id=%s  code=%d",
                        camera_id, ERR_CAMERA_REPLACED)
            await _safe_close(pair["camera"], "replaced by new camera connection")

        pair["camera"] = websocket

    try:
        async for message in websocket:
            # Камера -> конкретному клиенту по client_id из сообщения
            target_id = _extract_client_id(message)

            async with _lock:
                clients = dict(camera_pairs.get(camera_id, {}).get("clients", {}))

            size = _msg_size(message)

            if target_id and target_id in clients:
                log.debug("[CAMERA→CLIENT] id=%s  client=%s  %s", camera_id, target_id, size)
                await _send_safely(clients[target_id], message, camera_id, target_id)
            elif target_id:
                log.debug("[CAMERA→CLIENT] id=%s  client=%s  %s  — client not found, dropped",
                          camera_id, target_id, size)
            else:
                # Системное сообщение без client_id — broadcast всем
                log.debug("[CAMERA→CLIENT] id=%s  %s  — broadcast to %d clients",
                          camera_id, size, len(clients))
                for cid, client_ws in clients.items():
                    await _send_safely(client_ws, message, camera_id, cid)

    except (ConnectionClosedOK, ConnectionClosedError) as exc:
        log.info("[CAMERA] disconnected  id=%s  reason=%s", camera_id, exc)
    except Exception:
        log.exception("[CAMERA] unexpected error  id=%s", camera_id)
    finally:
        await _cleanup_camera_disconnect(camera_id, websocket)


async def handle_client_for_camera(camera_id: str, websocket) -> None:
    log.info("[CAM-CLIENT] connected  id=%s  remote=%s", camera_id, websocket.remote_address)

    # client_id назначим на первом сообщении (где он лежит в JSON).
    # До этого момента храним как None — для cleanup'а используем сам ws.
    assigned_client_id: str | None = None

    try:
        async for message in websocket:
            client_id = _extract_client_id(message)

            # При самом первом сообщении регистрируем клиента в пуле
            if assigned_client_id is None and client_id:
                async with _lock:
                    pair = camera_pairs.setdefault(
                        camera_id, {"camera": None, "clients": {}}
                    )
                    pair["clients"][client_id] = websocket
                    assigned_client_id = client_id
                log.info("[CAM-CLIENT] registered  camera=%s  client=%s",
                         camera_id, client_id)

            async with _lock:
                camera = camera_pairs.get(camera_id, {}).get("camera")

            size = _msg_size(message)
            kind = _message_type(message)

            if camera:
                log.debug("[CAM-CLIENT→CAMERA] camera=%s  client=%s  %s",
                          camera_id, assigned_client_id, size)
                try:
                    await camera.send(message)
                except Exception as exc:
                    log.error("[CAM-CLIENT→CAMERA] send failed  camera=%s  error=%s",
                              camera_id, exc)
                    # The client must not wait for an answer that will never come
                    if kind == "connection":
                        await _send_error(websocket, "connection", camera_id, assigned_client_id,
                                          ERR_CAMERA_SEND_FAILED, f"send to camera failed: {exc}")
            else:
                log.debug("[CAM-CLIENT→CAMERA] camera=%s  %s  — no camera, answered %d",
                          camera_id, size, ERR_CAMERA_NOT_CONNECTED)
                # Only session requests are answered: follow-up messages of a
                # session that cannot exist would just spam the client
                if kind == "connection":
                    await _send_error(websocket, "connection", camera_id, assigned_client_id,
                                      ERR_CAMERA_NOT_CONNECTED, "camera is not connected to signaling")

    except (ConnectionClosedOK, ConnectionClosedError) as exc:
        log.info("[CAM-CLIENT] disconnected  camera=%s  client=%s  reason=%s",
                 camera_id, assigned_client_id, exc)
    except Exception:
        log.exception("[CAM-CLIENT] unexpected error  camera=%s  client=%s",
                      camera_id, assigned_client_id)
    finally:
        if assigned_client_id is not None:
            await _cleanup_client_disconnect(camera_id, assigned_client_id, websocket)


# ─────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────

def _extract_client_id(message) -> str | None:
    """Достаёт client_id из JSON. Безопасно для бинарных и невалидных сообщений."""
    if isinstance(message, (bytes, bytearray)):
        return None
    try:
        parsed = json.loads(message)
        if isinstance(parsed, dict):
            cid = parsed.get("client_id")
            return cid if isinstance(cid, str) else None
    except (json.JSONDecodeError, ValueError):
        pass
    return None


async def _send_safely(ws, message, camera_id: str, client_id: str | None) -> None:
    try:
        await ws.send(message)
    except Exception as exc:
        log.error("send failed  camera=%s  client=%s  error=%s",
                  camera_id, client_id, exc)


# ─────────────────────────────────────────
#  Cleanup
# ─────────────────────────────────────────

async def _cleanup_client_disconnect(camera_id: str, client_id: str, websocket) -> None:
    """Один клиент отключился — убираем только его, камеру и других не трогаем."""
    async with _lock:
        pair = camera_pairs.get(camera_id)
        if pair is None:
            return

        existing = pair["clients"].get(client_id)
        if existing is not websocket:
            log.debug("[CAMERA-PAIR] stale client cleanup ignored  camera=%s  client=%s",
                      camera_id, client_id)
            return

        pair["clients"].pop(client_id, None)
        log.info("[CAMERA-PAIR] removed client  camera=%s  client=%s  remaining=%d",
                 camera_id, client_id, len(pair["clients"]))

        # Если ни камеры, ни клиентов — выпиливаем пару
        if pair["camera"] is None and not pair["clients"]:
            camera_pairs.pop(camera_id, None)
            log.info("[CAMERA-PAIR] removed  id=%s", camera_id)


async def _cleanup_camera_disconnect(camera_id: str, websocket) -> None:
    """Камера отключилась — закрываем всех её клиентов."""
    async with _lock:
        pair = camera_pairs.get(camera_id)
        if pair is None:
            return

        if pair["camera"] is not websocket:
            log.debug("[CAMERA-PAIR] stale camera cleanup ignored  id=%s", camera_id)
            return

        clients = list(pair["clients"].values())
        pair["camera"] = None
        pair["clients"] = {}
        camera_pairs.pop(camera_id, None)

        log.info("[CAMERA-PAIR] camera gone, closing %d clients  id=%s",
                 len(clients), camera_id)

    # Закрываем клиентов ВНЕ lock, но сперва называем причину
    for client_ws in clients:
        await _send_error(client_ws, "close", camera_id, None,
                          ERR_CAMERA_GONE, "camera disconnected from signaling")
        await _safe_close(client_ws, "camera disconnected")


async def _cleanup_camera_side(camera_id: str, side: str, websocket) -> None:
    """
    Clear one side of a camera pair — but only if *our* websocket is still
    registered there. If a replacement has already taken the slot, do nothing.
    """
    async with _lock:
        pair = camera_pairs.get(camera_id)
        if pair is None:
            return

        if pair[side] is not websocket:
            log.debug("[CAMERA-PAIR] stale cleanup ignored  side=%s  id=%s", side, camera_id)
            return

        other_side = "client" if side == "camera" else "camera"
        other_ws = pair.get(other_side)

        pair[side] = None
        log.info("[CAMERA-PAIR] cleared %s  id=%s", side, camera_id)

        if pair["camera"] is None and pair["client"] is None:
            camera_pairs.pop(camera_id, None)
            log.info("[CAMERA-PAIR] removed  id=%s", camera_id)

        # 🔥 ВАЖНО: закрываем вторую сторону ВНЕ lock
    if other_ws:
        log.info("[CAMERA-PAIR] %s gone, closing %s  id=%s", side, other_side, camera_id)
        await _safe_close(other_ws, f"{side} disconnected")


# ─────────────────────────────────────────
#  Calibrator handlers
# ─────────────────────────────────────────

async def handle_calibrator(calibrator_id: str, websocket) -> None:
    log.info("[CALIBRATOR] connected  id=%s  remote=%s", calibrator_id, websocket.remote_address)

    async with _lock:
        pair = calibrator_pairs.setdefault(
            calibrator_id,
            {"calibrator": None, "client": None, "client_name": None, "client_remote": None, "client_since": None},
        )

        if pair["calibrator"] is not None:
            log.warning("[CALIBRATOR] replacing existing connection  id=%s", calibrator_id)
            await _safe_close(pair["calibrator"], "replaced by new calibrator connection")

        pair["calibrator"] = websocket

    try:
        async for message in websocket:
            async with _lock:
                client = calibrator_pairs.get(calibrator_id, {}).get("client")

            size = _msg_size(message)
            if client:
                log.debug("[CALIBRATOR→CLIENT] id=%s  %s", calibrator_id, size)
                try:
                    await client.send(message)
                except Exception as exc:
                    log.error("[CALIBRATOR→CLIENT] send failed  id=%s  error=%s", calibrator_id, exc)
            else:
                log.debug("[CALIBRATOR→CLIENT] id=%s  %s  — no client, dropped", calibrator_id, size)

    except (ConnectionClosedOK, ConnectionClosedError) as exc:
        log.info("[CALIBRATOR] disconnected  id=%s  reason=%s", calibrator_id, exc)
    except Exception as exc:
        log.exception("[CALIBRATOR] unexpected error  id=%s", calibrator_id)
    finally:
        await _cleanup_calibrator_pair(calibrator_id, websocket)


async def _ask_for_takeover(calibrator_id: str, websocket, holder_name, holder_remote, holder_since) -> bool:
    # Вопрос новому клиенту о разрыве чужой сессии; True — оператор согласился
    held_for = int(time.monotonic() - holder_since) if holder_since else None
    holder = holder_name or _fmt_remote(holder_remote)

    sent = await _send_session_message(websocket, "session_busy", {
        "code": ERR_CALIBRATOR_BUSY,
        "description": "calibrator session already in use",
        "holder": holder,
        "held_for_sec": held_for,
        "timeout_sec": TAKEOVER_TIMEOUT_SEC,
    })
    if not sent:
        return False

    log.info("[CAL-CLIENT] busy, waiting for takeover answer  id=%s  holder=%s", calibrator_id, holder)

    try:
        answer = await asyncio.wait_for(websocket.recv(), timeout=TAKEOVER_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        log.info("[CAL-CLIENT] takeover timed out  id=%s", calibrator_id)
        await _safe_close(websocket, "takeover confirmation timed out")
        return False
    except (ConnectionClosedOK, ConnectionClosedError) as exc:
        log.info("[CAL-CLIENT] left while asked about takeover  id=%s  reason=%s", calibrator_id, exc)
        return False

    if _message_type(answer) != "session_takeover":
        log.info("[CAL-CLIENT] takeover declined  id=%s", calibrator_id)
        await _safe_close(websocket, "takeover declined")
        return False

    log.info("[CAL-CLIENT] takeover confirmed  id=%s", calibrator_id)
    return True


async def _revoke_client(calibrator_id: str, client, new_name, new_remote) -> None:
    # Вытеснение прежнего клиента: сначала причина, потом закрытие
    taken_by = new_name or _fmt_remote(new_remote)
    await _send_session_message(client, "session_revoked", {
        "code": ERR_CALIBRATOR_TAKEN_OVER,
        "description": "session taken over by another client",
        "taken_by": taken_by,
    })
    log.info("[CAL-CLIENT] previous session revoked  id=%s  taken_by=%s", calibrator_id, taken_by)
    await _safe_close(client, "session taken over by another client")


async def handle_client_for_calibrator(calibrator_id: str, websocket, client_name: str | None = None) -> None:
    log.info("[CAL-CLIENT] connected  id=%s  name=%s  remote=%s",
             calibrator_id, client_name, websocket.remote_address)

    async with _lock:
        pair = calibrator_pairs.get(calibrator_id)
        has_calibrator = pair is not None and pair["calibrator"] is not None
        holder = pair.get("client") if pair else None
        holder_name = pair.get("client_name") if pair else None
        holder_remote = pair.get("client_remote") if pair else None
        holder_since = pair.get("client_since") if pair else None

    if not has_calibrator:
        log.warning("[CAL-CLIENT] rejected — calibrator not connected  id=%s", calibrator_id)
        await _send_session_message(websocket, "session_error", {
            "code": ERR_CALIBRATOR_NOT_CONNECTED,
            "description": "calibrator is not connected to the broker",
        }, ret=False)
        await _safe_close(websocket, "calibrator not connected")
        return

    # Тот же клиент вернулся после обрыва: спрашивать разрешения у самого себя незачем
    same_client = bool(client_name) and client_name == holder_name

    # Слот один: занят — новый клиент решает, рвать ли чужую сессию
    if holder is not None and not same_client:
        if not await _ask_for_takeover(calibrator_id, websocket, holder_name, holder_remote, holder_since):
            return

    async with _lock:
        pair = calibrator_pairs.get(calibrator_id)
        if pair is None or pair["calibrator"] is None:
            calibrator = None
            previous = None
        else:
            previous = pair["client"]
            calibrator = pair["calibrator"]
            pair["client"] = websocket
            pair["client_name"] = client_name
            pair["client_remote"] = websocket.remote_address
            pair["client_since"] = time.monotonic()

    if calibrator is None:
        log.warning("[CAL-CLIENT] calibrator left while takeover was asked  id=%s", calibrator_id)
        await _send_session_message(websocket, "session_error", {
            "code": ERR_CALIBRATOR_NOT_CONNECTED,
            "description": "calibrator is not connected to the broker",
        }, ret=False)
        await _safe_close(websocket, "calibrator not connected")
        return

    replaced = previous is not None and previous is not websocket

    if replaced:
        await _revoke_client(calibrator_id, previous, client_name, websocket.remote_address)
        # Свой же вернувшийся клиент пайплайн не гасит: он продолжит с тем же потоком
        if not same_client:
            await _ask_calibrator_to_stop(calibrator_id, calibrator, "session taken over")

    # Клиент занял слот: до этого сообщения открытый сокет ещё ничего не значит
    await _send_session_message(websocket, "session_ready", {
        "description": "calibrator session granted",
        "took_over": replaced and not same_client,
        "resumed": replaced and same_client,
    }, ret=True)

    try:
        async for message in websocket:
            async with _lock:
                calibrator = calibrator_pairs.get(calibrator_id, {}).get("calibrator")

            size = _msg_size(message)
            if calibrator:
                log.debug("[CAL-CLIENT→CALIBRATOR] id=%s  %s", calibrator_id, size)
                try:
                    await calibrator.send(message)
                except Exception as exc:
                    log.error("[CAL-CLIENT→CALIBRATOR] send failed  id=%s  error=%s", calibrator_id, exc)
            else:
                log.debug("[CAL-CLIENT→CALIBRATOR] id=%s  %s  — no calibrator, dropped", calibrator_id, size)

    except (ConnectionClosedOK, ConnectionClosedError) as exc:
        log.info("[CAL-CLIENT] disconnected  id=%s  reason=%s", calibrator_id, exc)
    except Exception as exc:
        log.exception("[CAL-CLIENT] unexpected error  id=%s", calibrator_id)
    finally:
        await _cleanup_calibrator_side(calibrator_id, "client", websocket)


async def _cleanup_calibrator_pair(calibrator_id: str, websocket) -> None:
    """Force-close entire calibrator pair (used when calibrator disconnects)."""
    async with _lock:
        pair = calibrator_pairs.get(calibrator_id)
        if pair is None:
            return

        if pair["calibrator"] is not websocket:
            log.debug("[CAL-PAIR] stale calibrator cleanup ignored  id=%s", calibrator_id)
            return

        calibrator_pairs.pop(calibrator_id)
        log.info("[CAL-PAIR] calibrator gone, closing client  id=%s", calibrator_id)

    await _safe_close(pair.get("client"), "calibrator disconnected")
    log.info("[CAL-PAIR] removed  id=%s", calibrator_id)


async def _ask_calibrator_to_stop(calibrator_id: str, calibrator, description: str) -> None:
    # Просьба погасить пайплайн; keep_images бережёт набор снимков оператора
    if calibrator is None:
        return

    message = json.dumps({
        "type": "close",
        "client_id": "broker",
        "camera": None,
        "meta": {
            "description": description,
            "keep_images": True,
        },
        "ret": "none",
    })

    try:
        await calibrator.send(message)
        log.info("[CAL-PAIR] asked calibrator to stop  id=%s  reason=%s", calibrator_id, description)
    except Exception as exc:
        log.error("[CAL-PAIR] cannot notify calibrator  id=%s  error=%s", calibrator_id, exc)


async def _notify_calibrator_client_gone(calibrator_id: str, calibrator) -> None:
    """
    Сообщить калибратору, что смотреть больше некому.

    Канал калибратора допускает ровно одного клиента, поэтому его уход
    однозначно значит, что пайплайн работает впустую. Сам калибратор об
    отключении не узнаёт и продолжает считать undistort в фоне.

    Страховка нужна для случаев, когда клиент не успел проститься: краха
    вкладки, обрыва сети, убитого браузера. Набор снимков не трогаем —
    оператор может вернуться и продолжить.
    """
    await _ask_calibrator_to_stop(calibrator_id, calibrator, "client disconnected")


async def _cleanup_calibrator_side(calibrator_id: str, side: str, websocket) -> None:
    calibrator_to_notify = None

    async with _lock:
        pair = calibrator_pairs.get(calibrator_id)
        if pair is None:
            return

        if pair[side] is not websocket:
            log.debug("[CAL-PAIR] stale cleanup ignored  side=%s  id=%s", side, calibrator_id)
            return

        pair[side] = None
        log.info("[CAL-PAIR] cleared %s  id=%s", side, calibrator_id)

        if side == "client":
            pair["client_name"] = None
            pair["client_remote"] = None
            pair["client_since"] = None
            calibrator_to_notify = pair["calibrator"]

        if pair["calibrator"] is None and pair["client"] is None:
            calibrator_pairs.pop(calibrator_id, None)
            log.info("[CAL-PAIR] removed  id=%s", calibrator_id)

    # Отправка вне блокировки: send может ждать сеть, а лок держит весь брокер
    await _notify_calibrator_client_gone(calibrator_id, calibrator_to_notify)


# ─────────────────────────────────────────
#  External HTTP endpoint  /destroy/<type>/<id>
#  (handled over the same WS port via HTTP upgrade rejection trick)
#
#  Exposed as a tiny asyncio TCP server on port 8766 so it works
#  with plain curl without any extra dependencies.
# ─────────────────────────────────────────

async def handle_destroy_request(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        raw = await asyncio.wait_for(reader.read(1024), timeout=5)
        first_line = raw.decode(errors="replace").split("\r\n")[0]
        # GET /destroy/camera/abc123 HTTP/1.1
        parts = first_line.split()
        if len(parts) < 2:
            _http_respond(writer, 400, "Bad Request")
            return

        path_parts = parts[1].strip("/").split("/")
        # ["destroy", <type>, <id>]
        if len(path_parts) != 3 or path_parts[0] != "destroy":
            _http_respond(writer, 404, "Not Found")
            return

        _, target_type, target_id = path_parts

        if target_type == "camera":
            await _force_destroy_camera(target_id)
            _http_respond(writer, 200, f"camera pair {target_id} destroyed")
        elif target_type == "calibrator":
            await _force_destroy_calibrator(target_id)
            _http_respond(writer, 200, f"calibrator pair {target_id} destroyed")
        else:
            _http_respond(writer, 400, f"unknown type: {target_type}")

    except asyncio.TimeoutError:
        _http_respond(writer, 408, "Request Timeout")
    except Exception as exc:
        log.exception("[HTTP] error handling destroy request")
        _http_respond(writer, 500, str(exc))
    finally:
        writer.close()


def _http_respond(writer: asyncio.StreamWriter, status: int, body: str) -> None:
    payload = body.encode()
    response = (
        f"HTTP/1.1 {status} \r\n"
        f"Content-Type: text/plain\r\n"
        f"Content-Length: {len(payload)}\r\n"
        f"Connection: close\r\n\r\n"
    ).encode() + payload
    writer.write(response)


async def _force_destroy_camera(camera_id: str) -> None:
    async with _lock:
        pair = camera_pairs.pop(camera_id, None)

    if pair is None:
        log.warning("[DESTROY] camera pair not found  id=%s", camera_id)
        return

    log.info("[DESTROY] closing camera pair  id=%s  clients=%d",
             camera_id, len(pair.get("clients", {})))
    await _safe_close(pair.get("camera"), "destroyed by external request")
    for client_ws in pair.get("clients", {}).values():
        await _safe_close(client_ws, "destroyed by external request")
    log.info("[DESTROY] camera pair closed  id=%s", camera_id)


async def _force_destroy_calibrator(calibrator_id: str) -> None:
    async with _lock:
        pair = calibrator_pairs.pop(calibrator_id, None)

    if pair is None:
        log.warning("[DESTROY] calibrator pair not found  id=%s", calibrator_id)
        return

    log.info("[DESTROY] closing calibrator pair  id=%s", calibrator_id)
    await _safe_close(pair.get("calibrator"), "destroyed by external request")
    await _safe_close(pair.get("client"), "destroyed by external request")
    log.info("[DESTROY] calibrator pair closed  id=%s", calibrator_id)


# ─────────────────────────────────────────
#  WebSocket router
# ─────────────────────────────────────────

async def router(websocket) -> None:
    path = websocket.request.path          # websockets >= 12
    log.debug("[ROUTER] incoming  path=%s  remote=%s", path, websocket.remote_address)

    try:
        route, _, query = path.partition("?")
        parts = route.strip("/").split("/")
        if len(parts) != 2:
            log.warning("[ROUTER] invalid path  path=%s", path)
            await websocket.close(1002, "invalid path")
            return

        role, entity_id = parts
        client_name = _query_value(query, "client")

        routes = {
            "camera":     handle_camera,
            "client":     handle_client_for_camera,
            "calibrator": handle_calibrator,
            "cal-client": handle_client_for_calibrator,
        }

        handler = routes.get(role)
        if handler is None:
            log.warning("[ROUTER] unknown role=%s", role)
            await websocket.close(1002, f"unknown role: {role}")
            return

        if role == "cal-client":
            await handler(entity_id, websocket, client_name)
        else:
            await handler(entity_id, websocket)

    except Exception:
        log.exception("[ROUTER] unhandled error  path=%s", path)


# ─────────────────────────────────────────
#  Entry point
# ─────────────────────────────────────────

async def main() -> None:
    log.info("WebSocket broker starting on ws://0.0.0.0:8765")
    log.info("HTTP destroy endpoint on http://0.0.0.0:8766/destroy/<type>/<id>")

    http_server = await asyncio.start_server(
        handle_destroy_request, "0.0.0.0", 8766
    )

    async with serve(router, "0.0.0.0", 8765), http_server:
        log.info("Broker ready")
        await asyncio.Future()   # run forever


if __name__ == "__main__":
    asyncio.run(main())
