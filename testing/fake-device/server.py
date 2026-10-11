# Поддельная плата техзрения: ответы media-center на 7777 из памяти, без камер и NPU
# Режимы: POST /_mode/ok | no_module (404 на /neural/* при neural в модулях) | bare (404 и модулей нет)
import argparse

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
mode = {"name": "ok"}

CONFIGS = {
    "railway_camera": {
        "name": "YOLOv8 COCO (80 классов)",
        "superclasses": {"info": {"name": "Информация", "color": "#4d8bff"}},
        "classes": {"0": {"name": "person", "server_id": "", "superclass": "info", "color": "#49ff00"}},
    },
    "fake-config": {
        "name": "Поддельная конфигурация",
        "superclasses": {"fake_super": {"name": "Поддельный суперкласс", "color": "#c07cff"}},
        "classes": {
            "0": {"name": "Поддельный класс А", "server_id": "", "superclass": "fake_super", "color": "#ff7a00"},
            "1": {"name": "Поддельный класс Б", "server_id": "", "superclass": "fake_super", "color": "#00c2a8"},
        },
    },
}
for cfg in CONFIGS.values():
    cfg.update({
        "model_path": "/home/orangepi/varan/neural/models/fake.rknn",
        "thresholds": {"nms": 0.45, "confidence": 0.4},
        "tracker": {"type": "iou", "iou_threshold": 0.5, "min_hits": 5, "max_lost": 12, "move_threshold": 0.1},
        "model_width": 640, "model_height": 640, "fps": 20,
    })

STREAMS = [{
    "id": "fake_stream", "name": "Поддельный поток", "config_id": "fake-config", "width": 640, "height": 640,
    "rows": 1, "cols": 1, "row_fr": [], "col_fr": [],
    "tiles": [{"camera": "camera_f1", "row": 0, "col": 0, "row_span": 1, "col_span": 1, "crop": [0, 0, 1, 1], "fit": "letterbox"}],
}, {
    "id": "fake_broken", "name": "Поток с ошибкой", "config_id": "railway_camera", "width": 640, "height": 640,
    "rows": 1, "cols": 1, "row_fr": [], "col_fr": [],
    "tiles": [{"camera": "camera_f1", "row": 0, "col": 0, "row_span": 1, "col_span": 1, "crop": [0, 0, 1, 1], "fit": "stretch"}],
}]

STATE = [
    {"stream_id": "fake_stream", "config_id": "fake-config", "depth": 1, "fps": 10, "streaming": {"enabled": False, "name": ""},
     "image_mask": ["confirmed"], "packet_mask": ["confirmed", "updated", "removed"]},
    {"stream_id": "fake_broken", "config_id": "railway_camera", "depth": 1, "fps": 10, "streaming": {"enabled": False, "name": ""},
     "image_mask": ["confirmed"], "packet_mask": ["confirmed", "updated", "removed"]},
]

CAMERA = {
    "description": "", "display_name": "Поддельная камера", "ip_adress": "10.255.0.1", "password": "", "port": "554",
    "production": 1, "user": "admin",
    "streams": {"stream_1": {
        "channel": 1, "codec": "H264", "fps": 25, "width": 1920, "height": 1080, "latency": 0,
        "purposes": ["view", "neural"], "reconnect": 10, "record_path": "", "rtsp": "rtsp://10.255.0.1:554/fake",
        "segment": 600, "status": 3, "substream": 1, "use_udp": False,
    }},
}


def ok(data):
    return {"data": data}


def slot(stream_id, config_id, code, error):
    return {
        "stream_id": stream_id, "config_id": config_id, "running": code == 0,
        "canvas": {"width": 640, "height": 640},
        "tiles": [{"camera": "camera_f1", "state": "ok", "cell": [0, 0, 640, 640], "rect": [0, 80, 640, 480],
                   "camera_width": 1920, "camera_height": 1080}],
        "depth": 1, "depth_actual": 1, "fps_limit": 10, "layout": "single output [1, 4+nc, anchors]",
        "code": code, "error": error, "infer_ms": 30.0 if code == 0 else 0, "wait_ms": 0.1,
        "fps": 10.0 if code == 0 else 0, "detections": 0, "tracks": 0, "dropped": 0,
    }


@app.middleware("http")
async def neural_gate(request: Request, call_next):
    # Режим no_module: маршруты /neural/* не заведены, как на плате без загрузчика
    if request.url.path.startswith("/neural/") and mode["name"] != "ok":
        return JSONResponse({"error": "not found"}, status_code=404)
    return await call_next(request)


@app.post("/_mode/{name}")
async def set_mode(name: str):
    mode["name"] = name
    return mode


@app.get("/system/info")
async def system_info():
    return ok({
        "device_id": args.id, "hostname": "fake", "version": "1.1.0",
        "modules": [] if mode["name"] == "bare" else ["neural"],
        "platform": {"platform": "rk3588", "label": "RK3588", "npu_cores": 3}, "uptime_sec": 100.0,
        "cpu": {"cores": 8, "load_1": 0.5, "load_5": 0.5, "load_15": 0.5, "percent": 5.0},
        "memory": {"total_bytes": 8 << 30, "available_bytes": 6 << 30},
        "temperature": [{"zone": "soc-thermal", "celsius": 40.0}],
        "network": [{"iface": "eth0", "rx_bytes": 0, "tx_bytes": 0}],
        "disks": [],
    })


@app.get("/camera")
async def camera():
    return ok({"cameras": {"camera_f1": CAMERA}, "virtual": []})


@app.get("/streams")
async def streams():
    return ok([])


@app.get("/neural/status")
async def neural_status():
    return ok([slot("fake_stream", "fake-config", 0, ""), slot("fake_broken", "railway_camera", 6001, "fake model load failed")])


@app.get("/neural/configurations")
async def configurations(id: str | None = None):
    if id:
        return ok(CONFIGS[id]) if id in CONFIGS else JSONResponse({"error": "not found"}, status_code=404)
    return ok({"configurations": [{"id": k, "name": v["name"]} for k, v in CONFIGS.items()]})


@app.get("/neural/classes")
async def classes(config_id: str):
    cls = CONFIGS.get(config_id, {}).get("classes", {})
    return ok({"config_id": config_id, "classes": [{"id": int(k), **v} for k, v in cls.items()]})


@app.get("/neural/superclasses")
async def superclasses(config_id: str):
    sup = CONFIGS.get(config_id, {}).get("superclasses", {})
    return ok({"config_id": config_id, "superclasses": [{"key": k, **v} for k, v in sup.items()]})


@app.get("/neural/state")
async def get_state():
    return ok(STATE)


@app.post("/neural/state")
async def set_state(request: Request):
    STATE[:] = await request.json()
    return ok(STATE)


@app.get("/neural/streams")
async def get_streams(id: str | None = None):
    if id:
        found = next((s for s in STREAMS if s["id"] == id), None)
        return ok(found) if found else JSONResponse({"error": "not found"}, status_code=404)
    return ok({"streams": STREAMS})


@app.post("/neural/streams")
async def save_stream(request: Request):
    body = await request.json()
    STREAMS[:] = [s for s in STREAMS if s["id"] != body["id"]] + [body]
    return ok(body)


@app.delete("/neural/streams")
async def delete_stream(id: str):
    STREAMS[:] = [s for s in STREAMS if s["id"] != id]
    return ok({"id": id})


@app.post("/neural/{action}")
async def control(action: str):
    return ok({"action": action})


@app.get("/neural/system")
async def neural_system():
    return ok({"platform": "rk3588", "label": "RK3588", "npu_cores": 3, "contexts": 3, "core_mode": "auto"})


@app.get("/neural/event-types")
async def event_types():
    return ok({"events": [{"type": t} for t in ("created", "confirmed", "updated", "lost", "recovered", "removed")]})


@app.get("/neural/tracker-types")
async def tracker_types():
    return ok({"types": [{"type": "iou", "name": "IoU-трекер"}]})


@app.get("/neural/models")
async def models():
    return ok([{"filename": "fake.rknn", "size": 1000, "path": "/home/orangepi/varan/neural/models/fake.rknn"}])


parser = argparse.ArgumentParser(description="Fake neural device: media-center REST answers from memory")
parser.add_argument("--id", default="fake-second", help="device_id in /system/info")
parser.add_argument("--port", type=int, default=7777, help="media-center REST port the master polls")
args = parser.parse_args()

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
