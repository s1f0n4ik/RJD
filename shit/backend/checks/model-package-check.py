# Самопроверка контейнера модели .rjdm: cd shit/backend && python checks/model-package-check.py
import copy
import hashlib
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("AUTH_SECRET_FILE", str(Path(tempfile.gettempdir()) / "rjd-check-auth-secret"))


# Заголовок входа администратора: защищённые маршруты пропускают только его
def admin_headers() -> dict:
    from app.services.auth import create_access_token
    return {"Authorization": "Bearer " + create_access_token({"sub": "admin", "role": "admin"})}

TMP = tempfile.mkdtemp(prefix="model-package-check-")
os.environ["CONFIG_DB"] = f"{TMP}/api/config.db"
os.environ["CONFIG_ASSETS_DIR"] = f"{TMP}/api/assets"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.routers import neural_config  # noqa: E402
from app.services.model_package import asset_info, read_package  # noqa: E402

WEIGHTS = b"RKNN" + bytes(range(256)) * 8

MANIFEST = {
    "format": "rjdm",
    "schema_version": 1,
    "id": "rail-objects",
    "name": "Объекты пути",
    "version": "2026.11.1",
    "description": "Детектор предметов и людей на путях.\nОбучен на съёмке станции.",
    "author": "Отдел аналитики",
    "created_at": "2026-11-18T10:00:00Z",
    "weights": {"file": "weights.rknn", "target_platform": "rk3588", "toolkit_version": "2.3.2", "quantized": True},
    "model": {"task": "detect", "family": "yolo11", "input_width": 640, "input_height": 640, "output_layout": "split_levels", "class_count": 3},
    "superclasses": [
        {"key": "person", "name": "Человек", "color": "#F5A623"},
        {"key": "obstacle", "name": "Препятствие", "color": "#9F93F5"},
    ],
    "classes": [
        {"id": 0, "name": "Человек в «жилете»", "superclass": "person", "color": "#F5A623", "server_id": "person_vest"},
        {"id": 1, "name": "Чёрный чемодан", "superclass": "obstacle", "server_id": "suitcase"},
        {"id": 2, "name": "Коляска", "superclass": "obstacle", "color": "#7E6BE0"},
    ],
    "notes": "Порог confidence ниже 0.4 даёт много ложных на рельсах.",
}


def build(path: Path, manifest: dict, weights: bytes = WEIGHTS, *, fix: bool = True, method: int = zipfile.ZIP_STORED, raw: bytes | None = None) -> Path:
    manifest = copy.deepcopy(manifest)
    if fix:
        manifest["weights"].update(size=len(weights), sha256=hashlib.sha256(weights).hexdigest())
    text = raw if raw is not None else json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    with zipfile.ZipFile(path, "w", method) as z:
        z.writestr("manifest.json", text)
        z.writestr("weights.rknn", weights)
    return path


def mutated(change) -> dict:
    manifest = copy.deepcopy(MANIFEST)
    change(manifest)
    return manifest


def rejects(name: str, needle: str, **kwargs) -> None:
    manifest = kwargs.pop("manifest", MANIFEST)
    path = build(Path(TMP) / f"{name}.rjdm", manifest, **kwargs)
    try:
        read_package(path)
    except ValueError as e:
        assert needle in str(e), f"{name}: {e}"
        return
    raise AssertionError(f"{name}: accepted")


def main() -> None:
    good = build(Path(TMP) / "good.rjdm", MANIFEST)
    package = read_package(good)
    assert package["name"] == "Объекты пути" and package["author"] == "Отдел аналитики"
    assert package["classes"]["0"] == {"name": "Человек в «жилете»", "server_id": "person_vest", "superclass": "person", "color": "#F5A623"}
    # Цвет класса без своего берётся у суперкласса, id и название остаются разными полями
    assert package["classes"]["1"]["color"] == "#9F93F5" and package["classes"]["1"]["name"] == "Чёрный чемодан"
    assert package["classes"]["2"]["server_id"] == ""
    assert package["superclasses"]["person"] == {"name": "Человек", "color": "#F5A623"}
    assert (package["input_width"], package["input_height"], package["input_channels"], package["class_count"]) == (640, 640, 3, 3)
    assert package["weight_bytes"] == len(WEIGHTS) and package["weights_sha256"] == hashlib.sha256(WEIGHTS).hexdigest()
    assert "\n" in package["description"]

    # Буква «й» из «и» и комбинируемого символа приходит в NFC
    decomposed = mutated(lambda m: m["classes"][2].update(name="Коляска й"))
    assert read_package(build(Path(TMP) / "nfc.rjdm", decomposed))["classes"]["2"]["name"] == "Коляска й"
    # Экранированный манифест читается так же, как с живой кириллицей
    fixed = copy.deepcopy(MANIFEST)
    fixed["weights"].update(size=len(WEIGHTS), sha256=hashlib.sha256(WEIGHTS).hexdigest())
    escaped = build(Path(TMP) / "escaped.rjdm", MANIFEST, raw=json.dumps(fixed, ensure_ascii=True).encode())
    assert read_package(escaped) == package

    rejects("deflated", "stored without compression", manifest=MANIFEST, method=zipfile.ZIP_DEFLATED)
    rejects("sha", "weights.sha256 differs", manifest=mutated(lambda m: m["weights"].update(size=len(WEIGHTS), sha256="0" * 64)), fix=False)
    rejects("size", "weights.size", manifest=mutated(lambda m: m["weights"].update(size=1, sha256=hashlib.sha256(WEIGHTS).hexdigest())), fix=False)
    rejects("count", "class_count", manifest=mutated(lambda m: m["model"].update(class_count=4)))
    rejects("gap", "out of 0..", manifest=mutated(lambda m: m["classes"][2].update(id=5)))
    rejects("dup-id", "duplicated", manifest=mutated(lambda m: m["classes"][2].update(id=1)))
    rejects("dup-name", "name 'Коляска' is duplicated", manifest=mutated(lambda m: m["classes"][1].update(name="Коляска")))
    rejects("no-name", "name is empty", manifest=mutated(lambda m: m["classes"][1].update(name="  ")))
    rejects("super", "superclass 'ghost'", manifest=mutated(lambda m: m["classes"][1].update(superclass="ghost")))
    rejects("dup-super", "key 'person' is duplicated", manifest=mutated(lambda m: m["superclasses"].append({"key": "person", "name": "Ещё"})))
    rejects("super-key", "key must match", manifest=mutated(lambda m: m["superclasses"][0].update(key="Человек")))
    rejects("server-id", "server_id must match", manifest=mutated(lambda m: m["classes"][0].update(server_id="человек")))
    rejects("color", "color must be #RRGGBB", manifest=mutated(lambda m: m["classes"][0].update(color="red")))
    rejects("layout", "output_layout", manifest=mutated(lambda m: m["model"].update(output_layout="single_seg")))
    rejects("task", "model.task", manifest=mutated(lambda m: m["model"].update(task="classify")))
    rejects("input", "input_width", manifest=mutated(lambda m: m["model"].update(input_width=0)))
    rejects("schema", "newer than supported", manifest=mutated(lambda m: m.update(schema_version=2)))
    rejects("format", "format must be", manifest=mutated(lambda m: m.update(format="rknn")))
    rejects("quant", "weights.quantized", manifest=mutated(lambda m: m["weights"].pop("quantized")))
    rejects("bom", "UTF-8 JSON", raw=b"\xef\xbb\xbf" + json.dumps(MANIFEST).encode())
    rejects("cp1251", "UTF-8 JSON", raw=json.dumps(MANIFEST, ensure_ascii=False).encode("cp1251"))
    plain = Path(TMP) / "plain.rjdm"
    plain.write_bytes(b"not an archive")
    try:
        read_package(plain)
        raise AssertionError("plain file accepted")
    except ValueError as e:
        assert "ZIP" in str(e)
    only = Path(TMP) / "only.rjdm"
    with zipfile.ZipFile(only, "w", zipfile.ZIP_STORED) as z:
        z.writestr("manifest.json", json.dumps(MANIFEST))
    try:
        read_package(only)
        raise AssertionError("archive without weights accepted")
    except ValueError as e:
        assert "weights.rknn is missing" in str(e)

    # Загрузка и список моделей
    app = FastAPI()
    app.include_router(neural_config.router, prefix="/api")
    client = TestClient(app, headers=admin_headers())
    q = "device=none"
    r = client.post(f"/api/neural/models?filename=rail.rjdm&{q}", content=good.read_bytes())
    assert r.status_code == 200, r.text
    uploaded = r.json()["data"]
    assert uploaded["package"]["classes"]["0"]["name"] == "Человек в «жилете»" and uploaded["path"].endswith("/neural/models/rail.rjdm")
    r = client.post(f"/api/neural/models?filename=broken.rjdm&{q}", content=b"junk")
    assert r.status_code == 400 and "invalid .rjdm" in r.json()["detail"], r.text
    assert client.post(f"/api/neural/models?filename=old.rknn&{q}", content=b"old-model").status_code == 200
    assert client.post(f"/api/neural/models?filename=x.bin&{q}", content=b"x").status_code == 400
    listed = {m["filename"]: m for m in client.get(f"/api/neural/models?{q}").json()["data"]}
    assert set(listed) == {"rail.rjdm", "old.rknn"}, listed.keys()
    assert "package" not in listed["old.rknn"] and listed["rail.rjdm"]["package"]["name"] == "Объекты пути"
    info = asset_info(package)
    assert info["input_width"] == 640 and info["package"]["id"] == "rail-objects"
    print("ok")


main()
