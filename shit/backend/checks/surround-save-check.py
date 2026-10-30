import copy
import json
import os
import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
temporary = tempfile.TemporaryDirectory(prefix="surround-save-check-")
os.environ["CONFIG_DB"] = f"{temporary.name}/config.db"
os.environ["CONFIG_ASSETS_DIR"] = f"{temporary.name}/assets"

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx

from app.routers import surround
from app.services.config_bundle import export_profile, load_profile
from app.services.config_store import ConfigStore, get_store
from app.services.config_sync import _asset_shas, build_packages


def calibration(camera: str, focal: float) -> dict:
    matrix = {"rows": 3, "cols": 3, "type": 6, "data": [focal, 0, 320, 0, focal, 240, 0, 0, 1]}
    return {"id": camera, "width": 640, "height": 480, "camera_matrix": matrix, "new_K": matrix,
            "distortion_coeffs": {"rows": 4, "cols": 1, "type": 6, "data": [0, 0, 0, 0]}}


def main() -> None:
    store = get_store()
    dst = [[100, 100], [200, 100], [200, 200], [100, 200]]
    src = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
    preset = {"name": "stand", "canvas": {"width": 512, "height": 512}, "editor": {"version": 2, "step": 0.1},
              "machine": {"rect": [100, 100, 100, 200], "length": 4, "width": 2}, "opaque": {"keep": True},
              "cameras": {slot: {"name": slot, "src_points": src, "dst_points": dst, "camera_id": camera,
                                 "calibration": "original", "canvas_region": dst} for slot, camera in (("front", "a"), ("rear", "b"))}}
    entities = {
        ("place", "stand"): {"modules": ["birdview"]}, ("place", "other"): {"modules": ["birdview"]},
        ("camera", "a"): {"place": "stand"}, ("camera", "b"): {"place": "stand"},
        ("camera", "foreign"): {"place": "other"},
        ("calibration", "original"): {**calibration("a", 200), "place": "stand"},
        ("calibration", "foreign"): {**calibration("foreign", 200), "place": "other"},
        ("preset", "field"): {**preset, "place": "stand"},
        ("projection", "old"): {"place": "stand", "preset": "field", "cameras": {"front": {"name": "front"}, "rear": {"name": "rear"}},
                                "surround": {"orbit": {"speed": 0.2}}, "top": {"blend": 0.3}},
        ("surround_output", "stand"): {"active": "old", "configs": {"old": {"cameras": {"front": "a", "rear": "b"}, "fps": 25}}},
    }
    store.create_version("stand", "stand", entities)
    store.put("stand", "binding", "stand", {"device_id": "board"})
    store.set_active("stand")
    applied, failure = [], []

    async def push():
        applied.append(build_packages(store)["board"]["package"])
        return failure[0] if failure else None

    surround.sync.push_checked = push
    app = FastAPI()
    app.include_router(surround.router, prefix="/api")
    client = TestClient(app)

    def post(path: str, body: dict, status: int = 200):
        response = client.post(f"/api{path}?device=board", json=body)
        assert response.status_code == status, (path, response.status_code, response.text)
        return response

    def body(kind: str, key: str):
        return store.effective()["entities"][kind][key]["body"]

    before = store.passport("stand")
    post("/calibration/configuration", {"config_key": "x", "source": calibration("foreign", 100)}, 404)
    post("/calibration/configuration", {"config_key": "foreign", "source": calibration("a", 100)}, 409)
    post("/calibration/configuration", {"config_key": "x", "source": {**calibration("a", 100), "width": False}}, 400)
    post("/linker/state", {"export_id": "old", "cameras": {"front": False}}, 400)
    post("/linker/state", {"export_id": "old", "cameras": {"unknown": "a"}}, 400)
    post("/linker/state", {"export_id": "old", "cameras": {}, "rotation": False}, 400)
    post("/linker/top", {"resolution": {"width": 1000000000000}}, 400)
    post("/linker/top", {"model": {"source": "missing.glb"}}, 400)
    assert store.passport("stand") == before and not applied

    post("/calibration/configuration", {"config_key": "fresh", "source": calibration("b", 250)})
    assert applied[-1]["parts"]["surround"]["calibrations"]["fresh"]["id"] == "b"
    post("/calibration/links", {"links": {"b": {"config": "fresh", "fps": 20}}})
    assert body("correction_link", "b")["fps"] == 20
    post("/calibration/links", {"links": {}})
    assert not applied[-1]["parts"]["surround"]["links"]
    post("/linker/state", {"export_id": "old", "cameras": {"front": "a", "rear": "b"}, "fps": 20})
    post("/linker/rotation", {"rotation": 90})
    post("/linker/dual-output", {"dual_output": True})
    assert body("surround_output", "stand")["configs"]["old"]["rotation"] == 90
    post("/linker/surround", {"orbit": {"height": 2}})
    assert body("projection", "old")["surround"]["orbit"] == {"height": 2, "speed": 0.2}
    post("/linker/top", {"blend": 0.4, "model": {"alpha": 0.5}})
    post("/linker/surround-camera", {"place_key": "front", "position": [1, 2, 3], "yaw": 10})
    assert body("projection", "old")["surround"]["extrinsics"]["front"]["yaw"] == 10
    post("/linker/surround-camera", {"place_key": "front", "reset": True})
    assert not body("projection", "old")["surround"]["extrinsics"]

    edited = copy.deepcopy(preset)
    edited["cameras"]["front"]["src_points"] = []
    edited["cameras"]["front"].pop("camera_id")
    post("/linker/exports", {"field": edited})
    assert body("preset", "field")["cameras"]["front"]["src_points"] == src
    assert body("preset", "field")["cameras"]["front"]["camera_id"] == "a"

    source = {"preset_key": "field", "canvas": preset["canvas"], "cameras": {
        slot: {"src_points": src, "dst_points": dst, "camera_id": camera, "calibration_source": calibration(camera, focal)}
        for slot, camera, focal in (("front", "a", 200), ("rear", "b", 300))}}
    stale = copy.deepcopy(source)
    stale["cameras"]["front"]["dst_points"][0][0] += 1
    before = store.passport("stand")
    post("/linker/projection", {"id": "new", "name": "new", "source": stale}, 409)
    assert store.passport("stand") == before
    post("/linker/projection", {"id": "new", "name": "new", "source": source})
    part = applied[-1]["parts"]["surround"]
    assert part["presets"]["field"]["editor"] == preset["editor"] and part["presets"]["field"]["opaque"] == preset["opaque"]
    assert part["presets"]["field"]["cameras"]["rear"]["canvas_region"] == dst
    assert part["projections"]["new"]["preset"] == "field"
    assert part["calibrations"]["projection_new_front"]["camera_matrix"]["data"][0] == 200
    assert part["calibrations"]["projection_new_rear"]["camera_matrix"]["data"][0] == 300
    assert part["calibrations"]["original"] == {k: v for k, v in entities[("calibration", "original")].items() if k != "place"}
    assert part["output"]["active"] == "old" and part["output"]["configs"]["new"]["cameras"] == {"front": "a", "rear": "b"}

    def model(name: str, contents: bytes):
        response = client.post("/api/linker/upload-model?device=board", files={"model": (name, contents)})
        assert response.status_code == 200, response.text
        return response.json()["data"]["filename"]

    glb = b"glTF" + struct.pack("<II", 2, 16) + b"data"
    assert model("machine.glb", glb) == "machine.glb"
    assert model("alias.glb", glb) == "machine.glb"
    renamed = model("machine.glb", glb + b"different")
    assert renamed != "machine.glb"
    assert client.post("/api/linker/upload-model?device=board", files={"model": ("bad.glb", b"bad")}).status_code == 400
    post("/linker/top", {"model": {"source": renamed}})
    assert renamed in body("projection", "old")["_assets"]
    assert len(client.get("/api/linker/models?device=board").json()["data"]["models"]) == 2

    image_preset = copy.deepcopy(preset)
    image_preset["images"] = [{"name": "mat.png", "rect": [0, 0, 20, 20]}]
    response = client.post("/api/linker/exports?device=board", files={"config": (None, json.dumps({"image": image_preset})), "images": ("mat.png", b"image")})
    assert response.status_code == 200, response.text
    assert "mat.png" in body("preset", "image")["_assets"]
    post("/linker/exports", {"bad": {**image_preset, "images": [False]}}, 400)
    assert client.delete("/api/linker/preset?device=board&key=field").status_code == 409
    assert client.delete("/api/linker/export?device=board&id=old").status_code == 409
    assert client.delete("/api/linker/export?device=board&id=new").status_code == 200
    assert client.delete("/api/linker/preset?device=board&key=image").status_code == 200
    failure.append("injected apply failure")
    post("/linker/rotation", {"rotation": 180}, 502)
    assert body("surround_output", "stand")["configs"]["old"]["rotation"] == 180
    failure.clear()

    original_get, original_status = surround.registry.get, surround.sync.status
    original_client = httpx.AsyncClient
    operations = []

    def derived(request: httpx.Request):
        operations.append(request.url.path)
        assert json.loads(request.content)["export_id"] == "old"
        return httpx.Response(200, json={"data": {"export_id": "old"}})

    try:
        surround.registry.get = lambda _: {"ip": "board"}
        surround.sync.status = lambda: []
        post("/linker/recalc", {}, 409)
        assert not operations
        surround.sync.status = lambda: [{"device_id": "board", "state": "ok", "expected": "r", "applied": "r"}]
        httpx.AsyncClient = lambda **kwargs: original_client(transport=httpx.MockTransport(derived), **kwargs)
        post("/linker/recalc", {})
        post("/linker/top-version", {"version": "v2"})
        assert operations == ["/linker/recalc", "/linker/top-version"]
    finally:
        surround.registry.get, surround.sync.status = original_get, original_status
        httpx.AsyncClient = original_client

    store.fold("stand")
    bundle, _ = export_profile(store, "stand")
    restored = ConfigStore(f"{temporary.name}/restored/config.db", f"{temporary.name}/restored/assets")
    result = load_profile(restored, bundle)
    assert restored.version_entities(result["version"]["id"]) == store.version_entities(store.profile("stand")["version_id"])
    assert set(restored.assets()) == _asset_shas(list(store.version_entities(store.profile("stand")["version_id"]).values()))
    bundle.unlink()
    restored.close()
    store.close()
    print("surround-save-check: OK")


if __name__ == "__main__":
    try:
        main()
    finally:
        get_store().close()
