from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.config_cameras import camera_entry, patched_entry

DEVICE = "/dev/v4l/by-path/platform-xhci-hcd.0.auto-usb-0:1:1.0-video-index0"


def stream(purposes=("view", "record", "neural")):
    return {"substream": 1, "purposes": list(purposes), "latency": 0, "use_udp": False, "reconnect": 10,
            "record_path": "/storage/internal", "segment": 600}


def camera(streams=None, **v4l2):
    return {"id": "camera_9", "source": "v4l2", "streams": streams or {"stream_1": stream()},
            "v4l2": {"device": DEVICE, "format": "MJPG", "width": 1280, "height": 720, "fps": 30, **v4l2}}


def rejected(payload, text):
    try:
        camera_entry(payload, "place")
    except ValueError as error:
        assert text in str(error), str(error)
        return
    raise AssertionError(f"accepted: {text}")


# Камера на плате: без адреса и логина, поля по умолчанию
entry = camera_entry(camera(), "place")
assert entry["camera"]["source"] == "v4l2"
assert entry["camera"]["ip_adress"] == "" and entry["camera"]["port"] == "" and entry["camera"]["production"] == 0
assert entry["camera"]["v4l2"] == {"device": DEVICE, "format": "MJPG", "width": 1280, "height": 720, "fps": 30,
                                   "rotation": 0, "swap_uv": False, "bitrate": 0, "gop": 1}
assert list(entry["streams"]) == ["stream_1"] and entry["streams"]["stream_1"]["purposes"] == ["view", "record", "neural"]

full = camera_entry(camera(rotation=180, swap_uv=True, bitrate=2500, gop=2), "place")["camera"]["v4l2"]
assert full["rotation"] == 180 and full["swap_uv"] and full["bitrate"] == 2500 and full["gop"] == 2

# Сетевая камера хранится как раньше, без source
network = camera_entry({"id": "camera_1", "ip_adress": "192.168.1.36", "port": "554", "user": "admin", "password": "x",
                        "production": 2, "streams": {"stream_1": stream(("view",))}}, "place")
assert "source" not in network["camera"] and "v4l2" not in network["camera"]

rejected({**camera(), "source": "usb"}, "source must be rtsp or v4l2")
no_block = camera()
del no_block["v4l2"]
rejected(no_block, "Missing field: v4l2")
rejected({**camera(), "v4l2": "x"}, "v4l2 object")
rejected(camera(device=" "), "device is empty")
rejected(camera(format="H264"), "format must be")
rejected(camera(width=1281), "positive and even")
rejected(camera(height=0), "positive and even")
rejected(camera(fps=0), "fps is out of range")
rejected(camera(fps=121), "fps is out of range")
rejected(camera(rotation=45), "rotation must be")
# YUYV и UYVY поворачивает только сенсор CSI на 180
rejected(camera(format="YUYV", rotation=180), "only 180 by a CSI sensor")
rejected(camera(device="rkisp_mainpath", format="UYVY", rotation=90), "only 180 by a CSI sensor")
assert camera_entry(camera(device="rkisp_mainpath", format="UYVY", rotation=180), "place")["camera"]["v4l2"]["rotation"] == 180
assert camera_entry(camera(format="YUYV"), "place")["camera"]["v4l2"]["rotation"] == 0
assert camera_entry(camera(device="rkisp_mainpath", format="NV12", rotation=90), "place")["camera"]["v4l2"]["rotation"] == 90
rejected(camera(swap_uv="yes"), "swap_uv must be a boolean")
rejected(camera(bitrate=-1), "can't be negative")
rejected(camera(gop=0), "gop is out of range")
rejected(camera(gop=61), "gop is out of range")
rejected(camera(width="1280"), "must be an integer")
rejected(camera({"stream_1": stream(), "stream_2": stream(("view",))}), "exactly one stream")
rejected(camera({"stream_2": stream()}), "exactly one stream")

# Правка без source оставляет камеру на плате, с новым режимом в critical он меняется
changed = patched_entry(entry, {"critical": {"streams": {"stream_1": stream(("view",))}}})
assert changed["camera"]["source"] == "v4l2" and changed["camera"]["v4l2"]["device"] == DEVICE
assert changed["streams"]["stream_1"]["purposes"] == ["view"]

changed = patched_entry(entry, {"critical": {"source": "v4l2", "streams": {"stream_1": stream()},
                                             "v4l2": {**entry["camera"]["v4l2"], "format": "NV12", "rotation": 90}}})
assert changed["camera"]["v4l2"]["format"] == "NV12" and changed["camera"]["v4l2"]["rotation"] == 90

# Перевод в сетевую камеру требует адреса
moved = patched_entry(entry, {"critical": {"source": "rtsp", "ip_adress": "192.168.1.40", "port": "554", "user": "admin",
                                           "production": 2, "streams": {"stream_1": stream(("view",))}}})
assert "source" not in moved["camera"] and moved["camera"]["ip_adress"] == "192.168.1.40"

print("camera-v4l2-check: OK")
