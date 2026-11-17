import copy
import re
from typing import Any

# Проверки повторяют разбор POST/PATCH /camera в media-center
STREAM_KEY_RE = re.compile(r"^stream_[1-9][0-9]*$")
PURPOSES = ("view", "record", "neural", "birdview", "rtp")
RTP_MODES = ("copy", "transcode")
RTP_HOST_RE = re.compile(r"^[A-Za-z0-9._:-]{1,253}$")
CHANNELS = range(1, 7)
SUBSTREAMS = range(1, 7)
PRODUCTIONS = range(0, 4)
CAMERA_FIELDS = ("id", "ip_adress", "port", "user", "password", "production", "streams")
STREAM_FIELDS = ("substream", "purposes", "latency", "use_udp", "reconnect")
SOURCES = ("rtsp", "v4l2")
# Камера на плате: адреса и логина нет, поток ровно один
V4L2_CAMERA_FIELDS = ("id", "v4l2", "streams")
V4L2_FORMATS = ("YUYV", "UYVY", "NV12", "MJPG")
V4L2_ROTATIONS = (0, 90, 180, 270)


def _int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise ValueError(f"{field} must be an integer")
    return int(value)


def rtp_entry(name: str, raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"Stream {name}: rtp needs the rtp object")
    host = str(raw.get("host", "")).strip()
    if not RTP_HOST_RE.match(host):
        raise ValueError(f"Stream {name}: rtp host must be an address or a host name")
    port = _int(raw.get("port", 0), "rtp port")
    if not 1 <= port <= 65535:
        raise ValueError(f"Stream {name}: rtp port is out of range 1...65535")
    mode = raw.get("mode", "copy")
    if mode not in RTP_MODES:
        raise ValueError(f"Stream {name}: rtp mode must be copy or transcode")
    width, height, bitrate, qp_max = (_int(raw.get(key, 0), f"rtp {key}") for key in ("width", "height", "bitrate", "qp_max"))
    if min(width, height, bitrate) < 0:
        raise ValueError(f"Stream {name}: rtp width, height and bitrate can't be negative")
    if not 0 <= qp_max <= 51:
        raise ValueError(f"Stream {name}: rtp qp_max is out of range 0...51")
    # Минимальный кадр кодека
    if mode == "transcode" and (0 < width < 96 or 0 < height < 64):
        raise ValueError(f"Stream {name}: rtp frame is smaller than the encoder minimum 96x64")
    return {"host": host, "port": port, "mode": mode, "width": width, "height": height, "bitrate": bitrate, "qp_max": qp_max}


def v4l2_entry(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Camera source v4l2 needs the v4l2 object")
    device = str(raw.get("device", "")).strip()
    if not device:
        raise ValueError("v4l2 device is empty")
    fmt = raw.get("format")
    if fmt not in V4L2_FORMATS:
        raise ValueError("v4l2 format must be YUYV, UYVY, NV12 or MJPG")
    width, height, fps, rotation, bitrate, gop = (
        _int(raw.get(key, default), f"v4l2 {key}")
        for key, default in (("width", 0), ("height", 0), ("fps", 0), ("rotation", 0), ("bitrate", 0), ("gop", 1))
    )
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise ValueError("v4l2 frame size must be positive and even")
    if not 1 <= fps <= 120:
        raise ValueError("v4l2 fps is out of range 1...120")
    if rotation not in V4L2_ROTATIONS:
        raise ValueError("v4l2 rotation must be 0, 90, 180 or 270")
    # YUYV и UYVY кодер не поворачивает: остаётся 180 сенсором CSI, CSI задаётся именем узла, а не путём
    if fmt in ("YUYV", "UYVY") and rotation and not (rotation == 180 and not device.startswith("/dev/")):
        raise ValueError("v4l2 rotation of YUYV and UYVY is only 180 by a CSI sensor")
    swap_uv = raw.get("swap_uv", False)
    if not isinstance(swap_uv, bool):
        raise ValueError("v4l2 swap_uv must be a boolean")
    if bitrate < 0:
        raise ValueError("v4l2 bitrate can't be negative")
    if not 1 <= gop <= 60:
        raise ValueError("v4l2 gop is out of range 1...60 seconds")
    return {"device": device, "format": fmt, "width": width, "height": height, "fps": fps,
            "rotation": rotation, "swap_uv": swap_uv, "bitrate": bitrate, "gop": gop}


def stream_entry(name: str, raw: Any) -> dict:
    if not STREAM_KEY_RE.match(name):
        raise ValueError(f"Stream key {name!r} must look like stream_N")
    if not isinstance(raw, dict):
        raise ValueError(f"Stream {name} is not an object")
    for field in STREAM_FIELDS:
        if field not in raw:
            raise ValueError(f"Stream {name} does not contain the required field <{field}>")
    channel = _int(raw.get("channel", 1), "channel")
    substream = _int(raw["substream"], "substream")
    if channel not in CHANNELS:
        raise ValueError(f"Stream {name}: channel is out of range 1...6")
    if substream not in SUBSTREAMS:
        raise ValueError(f"Stream {name}: substream is out of range 1...6")
    purposes = raw["purposes"]
    if not isinstance(purposes, list) or not purposes:
        raise ValueError(f"Stream {name}: purposes must be a non-empty array of strings")
    for purpose in purposes:
        if purpose not in PURPOSES:
            raise ValueError(f"Stream {name}: unknown purpose {purpose!r}")
    if len(set(purposes)) != len(purposes):
        raise ValueError(f"Stream {name}: a purpose is listed twice")
    if not isinstance(raw["use_udp"], bool):
        raise ValueError(f"Stream {name}: use_udp must be a boolean")
    record = "record" in purposes
    if record and ("record_path" not in raw or "segment" not in raw):
        raise ValueError(f"Stream {name}: record needs record_path and segment")
    entry = {
        "name": name,
        "channel": channel,
        "substream": substream,
        "purposes": list(purposes),
        "latency": _int(raw["latency"], "latency"),
        "use_udp": raw["use_udp"],
        "reconnect_delay": _int(raw["reconnect"], "reconnect"),
        "record_path": str(raw["record_path"]) if record else "",
        "segment_length": _int(raw["segment"], "segment") if record else 0,
    }
    if "rtp" in purposes:
        entry["rtp"] = rtp_entry(name, raw.get("rtp"))
    return entry


def camera_entry(payload: Any, place: str) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Invalid JSON body")
    source = payload.get("source", "rtsp")
    if source not in SOURCES:
        raise ValueError("Camera source must be rtsp or v4l2")
    local = source == "v4l2"
    for field in V4L2_CAMERA_FIELDS if local else CAMERA_FIELDS:
        if field not in payload:
            raise ValueError(f"Missing field: {field}")
    production = 0 if local else _int(payload["production"], "production")
    if production not in PRODUCTIONS:
        raise ValueError("Not supported camera production!")
    if not isinstance(payload["streams"], dict):
        raise ValueError("Stream field is not json object!")
    if local and set(payload["streams"]) != {"stream_1"}:
        raise ValueError("Camera on board must have exactly one stream stream_1")
    camera = {
        "id": str(payload["id"]),
        "display_name": str(payload["display_name"]) if "display_name" in payload else "имя не установлено",
        "description": str(payload["description"]) if "description" in payload else "без описания",
        "ip_adress": "" if local else str(payload["ip_adress"]),
        "port": "" if local else str(payload["port"]),
        "user": "" if local else str(payload["user"]),
        "password": "" if local else str(payload["password"]),
        "production": production,
    }
    # Сетевая камера хранится как раньше, без поля source
    if local:
        camera["source"] = source
        camera["v4l2"] = v4l2_entry(payload["v4l2"])
    return {
        "place": place,
        "camera": camera,
        "streams": {name: stream_entry(name, raw) for name, raw in payload["streams"].items()},
    }


def patched_entry(entry: dict, body: Any) -> dict:
    if not isinstance(body, dict) or ("meta" not in body and "critical" not in body):
        raise ValueError("Empty PATCH: no meta or critical section provided")
    out = copy.deepcopy(entry)
    camera = out["camera"]
    meta = body.get("meta")
    if meta is not None:
        if not isinstance(meta, dict):
            raise ValueError("meta must be an object")
        if "display_name" not in meta and "description" not in meta:
            raise ValueError("No fields at meta block to update were provided")
        for field in ("display_name", "description"):
            if field in meta:
                camera[field] = str(meta[field])
    critical = body.get("critical")
    if critical is not None:
        if not isinstance(critical, dict):
            raise ValueError("critical must be an object")
        flat = {
            "id": camera["id"],
            "display_name": camera["display_name"],
            "description": camera["description"],
            "password": camera["password"],
            # Правка без source оставляет камеру тем, чем она была
            **{k: camera[k] for k in ("source", "v4l2") if k in camera},
            **{k: v for k, v in critical.items() if k not in ("id", "display_name", "description")},
        }
        out = camera_entry(flat, out["place"])
    return out
