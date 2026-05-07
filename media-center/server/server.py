import asyncio
import json
import logging
import websockets
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

# calibrator_id -> {"calibrator": ws | None, "client": ws | None}
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
        pair = camera_pairs.setdefault(camera_id, {"camera": None, "client": None})

        if pair["camera"] is not None:
            log.warning("[CAMERA] replacing existing connection  id=%s", camera_id)
            await _safe_close(pair["camera"], "replaced by new camera connection")

        pair["camera"] = websocket

    try:
        async for message in websocket:
            async with _lock:
                client = camera_pairs.get(camera_id, {}).get("client")

            size = _msg_size(message)
            if client:
                log.debug("[CAMERA→CLIENT] id=%s  %s", camera_id, size)
                try:
                    await client.send(message)
                except Exception as exc:
                    log.error("[CAMERA→CLIENT] send failed  id=%s  error=%s", camera_id, exc)
            else:
                log.debug("[CAMERA→CLIENT] id=%s  %s  — no client, dropped", camera_id, size)

    except (ConnectionClosedOK, ConnectionClosedError) as exc:
        log.info("[CAMERA] disconnected  id=%s  reason=%s", camera_id, exc)
    except Exception as exc:
        log.exception("[CAMERA] unexpected error  id=%s", camera_id)
    finally:
        await _cleanup_camera_side(camera_id, "camera", websocket)


async def handle_client_for_camera(camera_id: str, websocket) -> None:
    log.info("[CAM-CLIENT] connected  id=%s  remote=%s", camera_id, websocket.remote_address)

    async with _lock:
        pair = camera_pairs.setdefault(camera_id, {"camera": None, "client": None})

        if pair["client"] is not None:
            log.warning("[CAM-CLIENT] replacing existing connection  id=%s", camera_id)
            await _safe_close(pair["client"], "replaced by new client connection")

        pair["client"] = websocket

    try:
        async for message in websocket:
            async with _lock:
                camera = camera_pairs.get(camera_id, {}).get("camera")

            size = _msg_size(message)
            if camera:
                log.debug("[CAM-CLIENT→CAMERA] id=%s  %s", camera_id, size)
                try:
                    await camera.send(message)
                except Exception as exc:
                    log.error("[CAM-CLIENT→CAMERA] send failed  id=%s  error=%s", camera_id, exc)
            else:
                log.debug("[CAM-CLIENT→CAMERA] id=%s  %s  — no camera, dropped", camera_id, size)

    except (ConnectionClosedOK, ConnectionClosedError) as exc:
        log.info("[CAM-CLIENT] disconnected  id=%s  reason=%s", camera_id, exc)
    except Exception as exc:
        log.exception("[CAM-CLIENT] unexpected error  id=%s", camera_id)
    finally:
        await _cleanup_camera_side(camera_id, "client", websocket)


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
        pair = calibrator_pairs.setdefault(calibrator_id, {"calibrator": None, "client": None})

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


async def handle_client_for_calibrator(calibrator_id: str, websocket) -> None:
    log.info("[CAL-CLIENT] connected  id=%s  remote=%s", calibrator_id, websocket.remote_address)

    async with _lock:
        pair = calibrator_pairs.get(calibrator_id)

        # Only one client allowed — reject if calibrator not ready or client already present
        if pair is None or pair["calibrator"] is None:
            log.warning("[CAL-CLIENT] rejected — calibrator not connected  id=%s", calibrator_id)
            await websocket.close(1008, "calibrator not connected")
            return

        if pair["client"] is not None:
            log.warning("[CAL-CLIENT] rejected — pair already occupied  id=%s", calibrator_id)
            await websocket.close(1008, "calibrator session already in use")
            return

        pair["client"] = websocket

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


async def _cleanup_calibrator_side(calibrator_id: str, side: str, websocket) -> None:
    async with _lock:
        pair = calibrator_pairs.get(calibrator_id)
        if pair is None:
            return

        if pair[side] is not websocket:
            log.debug("[CAL-PAIR] stale cleanup ignored  side=%s  id=%s", side, calibrator_id)
            return

        pair[side] = None
        log.info("[CAL-PAIR] cleared %s  id=%s", side, calibrator_id)

        if pair["calibrator"] is None and pair["client"] is None:
            calibrator_pairs.pop(calibrator_id, None)
            log.info("[CAL-PAIR] removed  id=%s", calibrator_id)


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

    log.info("[DESTROY] closing camera pair  id=%s", camera_id)
    await _safe_close(pair.get("camera"), "destroyed by external request")
    await _safe_close(pair.get("client"), "destroyed by external request")
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
        parts = path.strip("/").split("/")
        if len(parts) != 2:
            log.warning("[ROUTER] invalid path  path=%s", path)
            await websocket.close(1002, "invalid path")
            return

        role, entity_id = parts

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
