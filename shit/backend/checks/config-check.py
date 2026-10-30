# Самопроверка конфигурации машины: cd shit/backend && python checks/config-check.py <varan-backup-*.tar.gz>
import copy
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
TMP = tempfile.mkdtemp(prefix="config-check-")
os.environ["CONFIG_DB"] = f"{TMP}/api/config.db"
os.environ["CONFIG_ASSETS_DIR"] = f"{TMP}/api/assets"

from app.services.config_bundle import export_profile, load_profile  # noqa: E402
from app.services.config_import import import_backups  # noqa: E402
from app.services.config_store import ConfigStore, check_refs, digest  # noqa: E402


def fresh(name: str) -> ConfigStore:
    return ConfigStore(f"{TMP}/{name}/config.db", f"{TMP}/{name}/assets")


def main(backup: Path) -> None:
    a = fresh("a")
    result = import_backups(a, [backup])
    entities = result["entities"]
    print("kinds:", dict(Counter(kind for kind, _ in entities)))
    print("places:", result["places"])
    print("collisions:", result["collisions"])
    print("warnings:", result["warnings"])
    assert entities and result["bindings"], "import produced nothing"
    assert not any(k == "neural_config" and "model_path" in b for (k, _), b in entities.items())
    assert not any(k == "projection" and "versions" in b for (k, _), b in entities.items())

    v1 = a.create_version("stand", "Стенд", entities, label="копия")
    for place, binding in result["bindings"].items():
        a.put("stand", "binding", place, binding)
    a.set_active("stand")
    eff = a.effective()
    print("broken:", json.dumps(eff["broken"], ensure_ascii=False, indent=1))
    assert v1["created"] and v1["number"] == 1
    assert a.create_version("stand", "Стенд", entities)["created"] is False, "same content must not add a version"

    # Круговой ход: выгрузка и загрузка в чистое хранилище дают ту же версию и те же файлы
    path, filename = export_profile(a, "stand")
    print("export:", filename, round(path.stat().st_size / 2**20, 1), "MiB")
    b = fresh("b")
    loaded = load_profile(b, path)
    path.unlink()
    assert loaded["version"]["hash"] == v1["hash"], "round trip changed the profile"
    assert b.version_entities(loaded["version"]["id"]) == a.version_entities(v1["id"])
    shas = {s for body in entities.values() if isinstance(body, dict) for s in (body.get("_assets") or {}).values() if s}
    assert set(b.assets()) == shas
    for sha in shas:
        assert b.asset_path(sha).stat().st_size == a.asset_path(sha).stat().st_size

    # Отличия паспорта
    cams = sorted(k for kind, k in entities if kind == "camera")
    c0, c1 = cams[0], cams[1]
    body = copy.deepcopy(entities[("camera", c0)])
    body["camera"]["ip_adress"] = "10.0.0.99"
    assert a.put("stand", "camera", c0, body) == "replace"
    assert a.put("stand", "camera", "camera_extra", {"place": "board-1", "camera": {"id": "camera_extra"}, "streams": {}}) == "add"
    assert a.remove("stand", "camera", c1) == "remove"
    eff = a.effective()
    assert eff["entities"]["camera"][c0]["state"] == "replaced"
    assert eff["entities"]["camera"]["camera_extra"]["state"] == "added"
    assert c1 not in eff["entities"]["camera"] and eff["removed"][0]["key"] == c1
    assert a.put("stand", "camera", "camera_same", entities[("camera", c0)]) == "add"
    a.reset("stand", "camera", "camera_same")
    assert a.put("stand", "camera", c0, entities[("camera", c0)]) == "profile", "identical body must drop the override"
    assert a.put("stand", "camera", c0, body) == "replace"

    # Профиль поменял заменённую камеру: пометка «в профиле новее», отличие живо
    newer = dict(entities)
    changed = copy.deepcopy(entities[("camera", c0)])
    changed["camera"]["display_name"] = "из профиля"
    newer[("camera", c0)] = changed
    v2 = a.create_version("stand", "Стенд", newer, label="новее")
    eff = a.effective()
    assert eff["entities"]["camera"][c0]["profile_newer"] and eff["entities"]["camera"][c0]["body"] == body
    a.select_version("stand", v1["id"])
    assert "profile_newer" not in a.effective()["entities"]["camera"][c0]

    # Откат: сбой внутри транзакции не оставляет ни версии, ни потерь в паспорте
    before = (len(a.profiles()[0]["versions"]), a.passport("stand"))
    try:
        with a._tx() as db:
            a.create_version("stand", "Стенд", {**entities, ("layout", "x"): {"name": "x"}})
            db.execute("DELETE FROM passport")
            raise RuntimeError("power loss")
    except RuntimeError:
        pass
    assert (len(a.profiles()[0]["versions"]), a.passport("stand")) == before
    assert a.profile("stand")["version_id"] == v1["id"]

    # «В профиль» и «Сохранить машину как профиль»
    v3 = a.promote("stand", "camera", c0)
    assert ("camera", c0) not in a.passport("stand")
    assert a.version_entities(v3["id"])[("camera", c0)] == body
    v4 = a.fold("stand")
    assert {k for k, _ in a.passport("stand")} == {"binding"}
    folded = a.version_entities(v4["id"])
    assert ("camera", "camera_extra") in folded and ("camera", c1) not in folded
    assert a.effective()["removed"] == []

    # Битый контур: зона, которой нет в каталоге конфигурации
    bodies = {kind: {} for kind in ("neural_config", "camera", "video_stream")}
    bodies["neural_config"]["cfg"] = {"zones": [{"id": 1}]}
    bodies["camera"]["cam"] = {}
    bodies["video_stream"]["s"] = {"tiles": [{"camera": "cam"}], "zones": {"cfg": {"cam": [{"zone": 2}]}}}
    assert [x["ref"] for x in check_refs(bodies)] == ["neural_config/cfg/zone/2"]
    assert digest({"b": 1, "a": 2}) == digest({"a": 2, "b": 1})

    api_check(backup, v1["hash"])
    print("config-check: OK", TMP)










def api_check(backup: Path, expected_hash: str) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import machine_config

    app = FastAPI()
    app.include_router(machine_config.router, prefix="/api")
    client = TestClient(app)
    with open(backup, "rb") as f:
        r = client.post("/api/config/import", files={"files": (backup.name, f)},
                        data={"profile_id": "stand-102", "name": "Стенд .102"})
    assert r.status_code == 200, r.text
    assert r.json()["version"]["hash"] == expected_hash
    assert client.get("/api/config/profiles").json()["active"] == "stand-102"
    r = client.put("/api/config/entities/layout/Новая сетка", json={"name": "Новая сетка", "activeCells": {}})
    assert r.json() == {"state": "add"}, r.text
    assert client.get("/api/config/effective").json()["entities"]["layout"]["Новая сетка"]["state"] == "added"
    r = client.get("/api/config/profiles/stand-102/export")
    assert r.status_code == 200 and r.headers["content-disposition"].endswith('stand-102-v1.varan"')
    r = client.post("/api/config/load", files={"file": ("p.varan", r.content)})
    assert r.status_code == 200 and r.json()["version"]["created"] is False, r.text
    assert client.post("/api/config/passport/fold").status_code == 200
    assert len(client.get("/api/config/profiles").json()["profiles"][0]["versions"]) == 2
    assert client.put("/api/config/entities/nope/x", json={}).status_code == 400


if __name__ == "__main__":
    main(Path(sys.argv[1]))
