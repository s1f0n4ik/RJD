from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.config_cameras import camera_entry, patched_entry


def stream(**rtp):
    return {"substream": 1, "purposes": ["view", "rtp"], "latency": 0, "use_udp": False, "reconnect": 10, "rtp": rtp}


def camera(streams):
    return {"id": "camera_1", "ip_adress": "192.168.1.36", "port": "554", "user": "admin", "password": "x",
            "production": 2, "streams": streams}


def rejected(streams, text):
    try:
        camera_entry(camera(streams), "place")
    except ValueError as error:
        assert text in str(error), str(error)
        return
    raise AssertionError(f"accepted: {text}")


# Режим по умолчанию — без перекодирования, остальные поля нули
entry = camera_entry(camera({"stream_1": stream(host="203.0.113.7", port=5004)}), "place")["streams"]["stream_1"]
assert entry["rtp"] == {"host": "203.0.113.7", "port": 5004, "mode": "copy", "width": 0, "height": 0, "bitrate": 0, "qp_max": 0}
assert entry["purposes"] == ["view", "rtp"]

entry = camera_entry(camera({"stream_1": stream(host="rx.example.org", port=5004, mode="transcode", width=640, height=360, bitrate=800, qp_max=36)}), "place")["streams"]["stream_1"]
assert entry["rtp"]["mode"] == "transcode" and entry["rtp"]["width"] == 640 and entry["rtp"]["qp_max"] == 36

# Без назначения rtp цели в записи нет
plain = stream(host="203.0.113.7", port=5004)
plain["purposes"] = ["view"]
assert "rtp" not in camera_entry(camera({"stream_1": plain}), "place")["streams"]["stream_1"]

rejected({"stream_1": stream()}, "rtp host")
rejected({"stream_1": stream(host="bad host", port=5004)}, "rtp host")
rejected({"stream_1": stream(host="203.0.113.7", port=0)}, "rtp port")
rejected({"stream_1": stream(host="203.0.113.7", port=70000)}, "rtp port")
rejected({"stream_1": stream(host="203.0.113.7", port=5004, mode="relay")}, "rtp mode")
rejected({"stream_1": stream(host="203.0.113.7", port=5004, qp_max=52)}, "qp_max")
rejected({"stream_1": stream(host="203.0.113.7", port=5004, bitrate=-1)}, "can't be negative")
rejected({"stream_1": stream(host="203.0.113.7", port=5004, mode="transcode", width=64)}, "96x64")

no_object = stream()
del no_object["rtp"]
rejected({"stream_1": no_object}, "rtp object")

# Правка камеры через critical пересобирает потоки вместе с rtp
base = camera_entry(camera({"stream_1": stream(host="203.0.113.7", port=5004)}), "place")
changed = patched_entry(base, {"critical": {
    "ip_adress": "192.168.1.36", "port": "554", "user": "admin", "production": 2,
    "streams": {"stream_1": stream(host="198.51.100.9", port=6000, mode="transcode", width=320, height=240)},
}})
assert changed["streams"]["stream_1"]["rtp"]["host"] == "198.51.100.9"
assert changed["streams"]["stream_1"]["rtp"]["mode"] == "transcode"

print("camera-rtp-check: OK")
