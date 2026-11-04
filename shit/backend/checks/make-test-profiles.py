import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

os.environ["DEBUG"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.config_bundle import FORMAT, _asset_shas, export_profile, load_profile
from app.services.config_store import ConfigStore, digest

root = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("test_profiles_rules", root / "detection-service/app/rules.py")
protocol = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = protocol
spec.loader.exec_module(protocol)

# Файлы профилей из экспорта stand-102: node/python make-test-profiles.py <stand-102.varan> <папка вывода>
RSM_ID, ISKRA_ID = "test-rsm-2000", "test-iskra"


def read_source(path: Path) -> tuple[dict, dict]:
    with zipfile.ZipFile(path) as z:
        doc = json.loads(z.read("profile.json"))
    return {(e["kind"], e["key"]): e["body"] for e in doc["entities"]}, doc["assets"]


def rules_body(model, patch: dict) -> dict:
    body = model().model_dump()
    for section, values in patch.items():
        body[section] = {**body[section], **values} if isinstance(body[section], dict) else values
    checked = model.model_validate(json.loads(json.dumps(body))).model_dump()
    return json.loads(json.dumps(checked))


def layout(source: dict, name: str, cells: dict) -> dict:
    body = copy.deepcopy(source)
    body.update({"name": name, "activeCells": cells, "detections": {}, "streams": {}, "corrections": {}, "overlays": {}})
    return body


def pick(source: dict, kind: str, *keys: str) -> dict:
    return {(kind, key): copy.deepcopy(source[(kind, key)]) for key in keys}


def build_rsm(source: dict, version: int) -> dict:
    cameras = ["camera_2", "camera_3"] + (["camera_6"] if version > 1 else []) + (["camera_5"] if version > 2 else [])
    stream = copy.deepcopy(source[("video_stream", "railway_camera_camera_n1")])
    stream.update({"id": "tehnika", "name": "Техника", "zones": {}})
    config = copy.deepcopy(source[("neural_config", "railway_camera")])
    config["thresholds"] = {**config.get("thresholds", {}), "confidence": 0.4, "nms": 0.5 if version > 1 else 0.45}
    entities = {
        ("place", "board-1"): {"name": "Главное устройство", "modules": ["neural"]},
        **pick(source, "camera", *cameras),
        ("video_stream", "tehnika"): stream,
        ("neural_config", "railway_camera"): config,
        ("neural_slot", "tehnika|railway_camera"): {"place": "board-1", "stream_id": "tehnika", "config_id": "railway_camera", "fps": 10, "depth": 2},
        ("layout", "РСМ-2000"): layout(source[("layout", "4 перца")], "РСМ-2000", {"0": "camera_2", "1": "camera_3", "2": "stream_railway_camera_tehnika", "3": cameras[-1]}),
        ("machine", "settings"): {"active_integration": "rsm-2000", "tz_offset_min": {1: 180, 2: 120, 3: 90}[version]},
        **pick(source, "integration", "rsm-2000"),
        ("rules", "rsm-2000"): rules_body(protocol.RsmSettings, {
            "stitch": {"gap_s": 3.0},
            "table": {"models": {"railway_camera": {"classes": {"0": 1, "1": 2}, "superclasses": {}, "zones": {}}},
                      "danger_override": {"railway_camera": {"0": 1}},
                      "cameras": {"camera_2": 1, "camera_3": 2}},
        }),
    }
    return entities


def build_iskra(source: dict) -> dict:
    return {
        ("place", "board-1"): {"name": "Главное устройство", "modules": ["birdview", "neural"]},
        **pick(source, "camera", "camera_3", "camera_1", "camera_4", "camera_5", "camera_6"),
        **pick(source, "video_stream", "stroyka"),
        **pick(source, "neural_config", "railway_camera_seg"),
        ("neural_slot", "stroyka|railway_camera_seg"): copy.deepcopy(source[("neural_slot", "stroyka")]),
        **pick(source, "calibration", "camera_4_1280_960", "camera_4_1280_960_surround", "test_qudaro"),
        **pick(source, "correction_link", "camera_1", "camera_4"),
        **pick(source, "preset", "molitva"),
        **pick(source, "projection", "test_v2_new"),
        **pick(source, "surround_output", "board-1"),
        ("layout", "Искра 360"): layout(source[("layout", "4 перца")], "Искра 360", {"0": "birdview_linker", "1": "camera_3", "2": "stream_railway_camera_seg_stroyka", "3": "camera_1"}),
        ("machine", "settings"): {"active_integration": "iskra", "tz_offset_min": 300},
        **pick(source, "integration", "iskra"),
        ("rules", "iskra"): rules_body(protocol.IskraSettings, {
            "table": {"models": {"railway_camera_seg": {"classes": {"0": 1}, "superclasses": {}, "zones": {}}},
                      "cameras": [{"bit": 1, "name": "Стройка", "camera_id": "camera_3"}, {"bit": 2, "name": "Левая", "camera_id": "camera_5"}]},
        }),
    }


def write(path: Path, profile_id: str, name: str, number: int, entities: dict, assets: dict) -> None:
    shas = _asset_shas(entities)
    doc = {
        "format": FORMAT,
        "profile": {"id": profile_id, "name": name},
        "version": {"number": number, "hash": digest(sorted([k, key, body] for (k, key), body in entities.items())), "label": "тестовый профиль", "created": 1793700000.0},
        "entities": [{"kind": kind, "key": key, "body": body} for (kind, key), body in sorted(entities.items())],
        "assets": {sha: assets[sha] for sha in shas},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("profile.json", json.dumps(doc, ensure_ascii=False, indent=1), zipfile.ZIP_DEFLATED)
        for sha in sorted(shas):
            z.write(SOURCE_ASSETS / sha, f"assets/{sha}", zipfile.ZIP_STORED)


def verify(folder: Path, files: list[Path]) -> None:
    with tempfile.TemporaryDirectory(prefix="test-profiles-check-") as tmp:
        store = ConfigStore(str(Path(tmp) / "config.db"), str(Path(tmp) / "assets"))
        try:
            for path in files:
                result = load_profile(store, path, select=True)
                effective = store.effective(result["profile"]["id"])
                assert not effective["broken"], f"{path.name}: {effective['broken']}"
                exported, _ = export_profile(store, result["profile"]["id"])
                again = ConfigStore(str(Path(tmp) / f"again-{path.stem}.db"), str(Path(tmp) / f"assets-{path.stem}"))
                try:
                    assert load_profile(again, exported)["version"]["id"] and again.profile(result["profile"]["id"])
                    assert digest(sorted(str(k) for k in again.version_entities(again.profile(result["profile"]["id"])["version_id"]))) == digest(sorted(str(k) for k in store.version_entities(result["version"]["id"])))
                finally:
                    again.close()
                    exported.unlink()
                print(f"{path.name}: {len(effective['entities'])} видов, камер {len(effective['entities'].get('camera', {}))}, без ошибок ссылок")
        finally:
            store.close()


if len(sys.argv) != 3:
    sys.exit("usage: make-test-profiles.py <stand-102.varan> <output folder>")
source_file, output = Path(sys.argv[1]), Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
source, assets = read_source(source_file)
SOURCE_ASSETS = output / ".source-assets"
SOURCE_ASSETS.mkdir(exist_ok=True)
with zipfile.ZipFile(source_file) as z:
    for sha in assets:
        (SOURCE_ASSETS / sha).write_bytes(z.read(f"assets/{sha}"))
files = [output / "test-rsm-2000-v1.varan", output / "test-iskra-v1.varan", output / "test-rsm-2000-v2.varan", output / "test-rsm-2000-v3.varan"]
write(files[0], RSM_ID, "Тест РСМ-2000", 1, build_rsm(source, 1), assets)
write(files[1], ISKRA_ID, "Тест Искра", 1, build_iskra(source), assets)
write(files[2], RSM_ID, "Тест РСМ-2000", 2, build_rsm(source, 2), assets)
write(files[3], RSM_ID, "Тест РСМ-2000", 3, build_rsm(source, 3), assets)
verify(output, files)
for path in SOURCE_ASSETS.iterdir():
    path.unlink()
SOURCE_ASSETS.rmdir()
print("test-profiles: OK", ", ".join(f"{p.name} {p.stat().st_size // 1024} КБ" for p in files))
