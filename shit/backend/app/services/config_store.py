import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

from app.config import settings

# Виды сущностей конфигурации машины
KINDS = (
    "place", "binding", "camera",
    "neural_config", "video_stream", "neural_slot", "tracker_defaults",
    "calibration", "correction_link", "preset", "projection", "surround_output",
    "integration", "rules", "layout", "machine",
)
# Виды, которые живут только в паспорте машины и не попадают в профиль
PASSPORT_ONLY = ("binding",)
OPS = ("replace", "add", "remove")

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version_id INTEGER,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    hash TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created REAL NOT NULL,
    UNIQUE(profile_id, number)
);
CREATE TABLE IF NOT EXISTS entities (
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY(version_id, kind, key)
);
CREATE TABLE IF NOT EXISTS passport (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    op TEXT NOT NULL,
    body TEXT,
    base_hash TEXT,
    updated REAL NOT NULL,
    PRIMARY KEY(profile_id, kind, key)
);
CREATE TABLE IF NOT EXISTS assets (
    sha256 TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    info TEXT,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS machine (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


class ConfigError(Exception):
    pass


def canon(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(obj: Any) -> str:
    return hashlib.sha256(canon(obj).encode("utf-8")).hexdigest()[:16]


def nest(flat: dict[tuple[str, str], Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for (kind, key), body in flat.items():
        out.setdefault(kind, {})[key] = body
    return out


class ConfigStore:
    def __init__(self, db_path: str, assets_dir: str):
        self._assets = Path(assets_dir)
        self._assets.mkdir(parents=True, exist_ok=True)
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._depth = 0
        self._db = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        # Борт штатно теряет питание: каждая транзакция доходит до диска
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    def _tx(self):
        return _Transaction(self)

    def transaction(self):
        return self._tx()

    # ── Файлы ──

    def asset_path(self, sha: str) -> Path:
        return self._assets / sha

    def put_asset_file(self, src: Path, name: str, info: Optional[dict] = None) -> str:
        h = hashlib.sha256()
        with open(src, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        sha = h.hexdigest()
        dst = self.asset_path(sha)
        if not dst.exists():
            fd, tmp = tempfile.mkstemp(dir=self._assets, prefix=".in-")
            with os.fdopen(fd, "wb") as out, open(src, "rb") as f:
                shutil.copyfileobj(f, out, 1 << 20)
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, dst)
        with self._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO assets(sha256, name, size, info, created) VALUES (?,?,?,?,?)",
                (sha, name, dst.stat().st_size, canon(info) if info else None, time.time()),
            )
            if info:
                db.execute("UPDATE assets SET info=? WHERE sha256=? AND info IS NULL", (canon(info), sha))
        return sha

    def set_asset_info(self, sha: str, info: dict) -> None:
        with self._tx() as db:
            db.execute("UPDATE assets SET info=? WHERE sha256=?", (canon(info), sha))

    def assets(self, shas: Optional[Iterable[str]] = None) -> dict[str, dict]:
        rows = self._db.execute("SELECT sha256, name, size, info, created FROM assets ORDER BY created").fetchall()
        wanted = set(shas) if shas is not None else None
        return {
            r["sha256"]: {
                "name": r["name"], "size": r["size"], "created": r["created"],
                "info": json.loads(r["info"]) if r["info"] else None,
            }
            for r in rows if wanted is None or r["sha256"] in wanted
        }

    # ── Профили и версии ──

    def profiles(self) -> list[dict]:
        active = self.active_profile()
        out = []
        for p in self._db.execute("SELECT * FROM profiles ORDER BY created").fetchall():
            versions = [
                {"id": v["id"], "number": v["number"], "hash": v["hash"], "label": v["label"], "created": v["created"]}
                for v in self._db.execute(
                    "SELECT * FROM versions WHERE profile_id=? ORDER BY number", (p["id"],)
                ).fetchall()
            ]
            overrides = self._db.execute(
                "SELECT COUNT(*) FROM passport WHERE profile_id=? AND kind NOT IN (%s)"
                % ",".join("?" * len(PASSPORT_ONLY)), (p["id"], *PASSPORT_ONLY),
            ).fetchone()[0]
            out.append({
                "id": p["id"], "name": p["name"], "version_id": p["version_id"],
                "active": p["id"] == active, "versions": versions, "overrides": overrides,
            })
        return out

    def profile(self, profile_id: str) -> dict:
        row = self._db.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone()
        if not row:
            raise ConfigError(f"profile {profile_id!r} not found")
        return dict(row)

    def create_version(
        self, profile_id: str, name: str, entities: dict[tuple[str, str], Any], label: str = ""
    ) -> dict:
        for kind, _ in entities:
            if kind not in KINDS or kind in PASSPORT_ONLY:
                raise ConfigError(f"kind {kind!r} is not allowed in a profile")
        vhash = digest(sorted([k, key, body] for (k, key), body in entities.items()))
        with self._tx() as db:
            if not db.execute("SELECT 1 FROM profiles WHERE id=?", (profile_id,)).fetchone():
                db.execute(
                    "INSERT INTO profiles(id, name, version_id, created) VALUES (?,?,NULL,?)",
                    (profile_id, name, time.time()),
                )
            same = db.execute(
                "SELECT * FROM versions WHERE profile_id=? AND hash=?", (profile_id, vhash)
            ).fetchone()
            if same:
                db.execute("UPDATE profiles SET version_id=? WHERE id=?", (same["id"], profile_id))
                return {"id": same["id"], "number": same["number"], "hash": vhash, "created": False}
            number = db.execute(
                "SELECT COALESCE(MAX(number), 0) + 1 FROM versions WHERE profile_id=?", (profile_id,)
            ).fetchone()[0]
            cur = db.execute(
                "INSERT INTO versions(profile_id, number, hash, label, created) VALUES (?,?,?,?,?)",
                (profile_id, number, vhash, label, time.time()),
            )
            version_id = cur.lastrowid
            db.executemany(
                "INSERT INTO entities(version_id, kind, key, body) VALUES (?,?,?,?)",
                [(version_id, kind, key, canon(body)) for (kind, key), body in entities.items()],
            )
            db.execute("UPDATE profiles SET version_id=? WHERE id=?", (version_id, profile_id))
            return {"id": version_id, "number": number, "hash": vhash, "created": True}

    def select_version(self, profile_id: str, version_id: int) -> None:
        with self._tx() as db:
            row = db.execute(
                "SELECT 1 FROM versions WHERE id=? AND profile_id=?", (version_id, profile_id)
            ).fetchone()
            if not row:
                raise ConfigError(f"version {version_id} of {profile_id!r} not found")
            db.execute("UPDATE profiles SET version_id=? WHERE id=?", (version_id, profile_id))

    def delete_version(self, profile_id: str, version_id: int) -> None:
        if self.profile(profile_id)["version_id"] == version_id:
            raise ConfigError("selected version cannot be deleted")
        with self._tx() as db:
            db.execute("DELETE FROM versions WHERE id=? AND profile_id=?", (version_id, profile_id))

    def delete_profile(self, profile_id: str) -> None:
        if self.active_profile() == profile_id:
            raise ConfigError("active profile cannot be deleted")
        with self._tx() as db:
            db.execute("DELETE FROM profiles WHERE id=?", (profile_id,))

    def active_profile(self) -> Optional[str]:
        row = self._db.execute("SELECT value FROM machine WHERE key='active_profile'").fetchone()
        return row["value"] if row else None

    def set_active(self, profile_id: str) -> None:
        self.profile(profile_id)
        with self._tx() as db:
            db.execute(
                "INSERT INTO machine(key, value) VALUES ('active_profile', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (profile_id,),
            )

    def version_entities(self, version_id: Optional[int]) -> dict[tuple[str, str], Any]:
        if version_id is None:
            return {}
        rows = self._db.execute(
            "SELECT kind, key, body FROM entities WHERE version_id=?", (version_id,)
        ).fetchall()
        return {(r["kind"], r["key"]): json.loads(r["body"]) for r in rows}

    def version(self, version_id: int) -> dict:
        row = self._db.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone()
        if not row:
            raise ConfigError(f"version {version_id} not found")
        return dict(row)

    # ── Паспорт ──

    def passport(self, profile_id: str) -> dict[tuple[str, str], dict]:
        rows = self._db.execute("SELECT * FROM passport WHERE profile_id=?", (profile_id,)).fetchall()
        return {
            (r["kind"], r["key"]): {
                "op": r["op"], "body": json.loads(r["body"]) if r["body"] is not None else None,
                "base_hash": r["base_hash"], "updated": r["updated"],
            }
            for r in rows
        }

    def _profile_body(self, profile_id: str, kind: str, key: str) -> Optional[Any]:
        version_id = self.profile(profile_id)["version_id"]
        row = self._db.execute(
            "SELECT body FROM entities WHERE version_id=? AND kind=? AND key=?", (version_id, kind, key)
        ).fetchone()
        return json.loads(row["body"]) if row else None

    def put(self, profile_id: str, kind: str, key: str, body: Any) -> str:
        if kind not in KINDS:
            raise ConfigError(f"unknown kind {kind!r}")
        base = self._profile_body(profile_id, kind, key)
        if base is not None and canon(base) == canon(body):
            self.reset(profile_id, kind, key)
            return "profile"
        op = "replace" if base is not None else "add"
        with self._tx() as db:
            db.execute(
                "INSERT INTO passport(profile_id, kind, key, op, body, base_hash, updated) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(profile_id, kind, key) DO UPDATE SET op=excluded.op, body=excluded.body, "
                "base_hash=excluded.base_hash, updated=excluded.updated",
                (profile_id, kind, key, op, canon(body), digest(base) if base is not None else None, time.time()),
            )
        return op

    def remove(self, profile_id: str, kind: str, key: str) -> str:
        base = self._profile_body(profile_id, kind, key)
        if base is None:
            self.reset(profile_id, kind, key)
            return "gone"
        with self._tx() as db:
            db.execute(
                "INSERT INTO passport(profile_id, kind, key, op, body, base_hash, updated) VALUES (?,?,?,?,NULL,?,?) "
                "ON CONFLICT(profile_id, kind, key) DO UPDATE SET op=excluded.op, body=NULL, "
                "base_hash=excluded.base_hash, updated=excluded.updated",
                (profile_id, kind, key, "remove", digest(base), time.time()),
            )
        return "remove"

    def reset(self, profile_id: str, kind: str, key: str) -> None:
        with self._tx() as db:
            db.execute(
                "DELETE FROM passport WHERE profile_id=? AND kind=? AND key=?", (profile_id, kind, key)
            )

    def promote(self, profile_id: str, kind: str, key: str) -> dict:
        if kind in PASSPORT_ONLY:
            raise ConfigError(f"{kind!r} lives only in the passport")
        with self._tx():
            override = self.passport(profile_id).get((kind, key))
            if not override:
                raise ConfigError(f"{kind}/{key} has no machine override")
            prof = self.profile(profile_id)
            entities = self.version_entities(prof["version_id"])
            if override["op"] == "remove":
                entities.pop((kind, key), None)
            else:
                entities[(kind, key)] = override["body"]
            version = self.create_version(profile_id, prof["name"], entities, label=f"{kind}/{key}")
            self.reset(profile_id, kind, key)
            return version

    def fold(self, profile_id: str, label: str = "") -> dict:
        with self._tx() as db:
            prof = self.profile(profile_id)
            entities = {
                (kind, key): body
                for (kind, key), body in self._overlay(profile_id).items()
                if kind not in PASSPORT_ONLY
            }
            version = self.create_version(profile_id, prof["name"], entities, label=label)
            db.execute(
                "DELETE FROM passport WHERE profile_id=? AND kind NOT IN (%s)" % ",".join("?" * len(PASSPORT_ONLY)),
                (profile_id, *PASSPORT_ONLY),
            )
            return version

    # ── Действующая конфигурация ──

    def _overlay(self, profile_id: str) -> dict[tuple[str, str], Any]:
        flat = self.version_entities(self.profile(profile_id)["version_id"])
        for (kind, key), ov in self.passport(profile_id).items():
            if ov["op"] == "remove":
                flat.pop((kind, key), None)
            else:
                flat[(kind, key)] = ov["body"]
        return flat

    def effective(self, profile_id: Optional[str] = None) -> dict:
        profile_id = profile_id or self.active_profile()
        if not profile_id:
            return {"profile": None, "entities": {}, "removed": [], "broken": []}
        prof = self.profile(profile_id)
        base = self.version_entities(prof["version_id"])
        overrides = self.passport(profile_id)

        entities: dict[str, dict[str, dict]] = {}
        for (kind, key), body in base.items():
            entities.setdefault(kind, {})[key] = {"body": body, "state": "profile"}
        removed = []
        for (kind, key), ov in overrides.items():
            in_profile = (kind, key) in base
            newer = in_profile and ov["base_hash"] != digest(base[(kind, key)])
            if ov["op"] == "remove":
                entities.get(kind, {}).pop(key, None)
                removed.append({"kind": kind, "key": key, "profile_newer": newer, "in_profile": in_profile})
                continue
            if in_profile:
                state = "replaced"
            else:
                state = "machine_only" if ov["op"] == "replace" else "added"
            entry = {"body": ov["body"], "state": state}
            if newer:
                entry["profile_newer"] = True
            entities.setdefault(kind, {})[key] = entry

        bodies = {kind: {key: e["body"] for key, e in items.items()} for kind, items in entities.items()}
        broken = check_refs(bodies) + self._missing_assets(bodies)
        return {
            "profile": {"id": prof["id"], "name": prof["name"], "version_id": prof["version_id"]},
            "entities": entities, "removed": removed, "broken": broken,
        }

    def _missing_assets(self, bodies: dict[str, dict[str, Any]]) -> list[dict]:
        known = set(self.assets().keys())
        out = []
        for kind, items in bodies.items():
            for key, body in items.items():
                for name, sha in (body.get("_assets") or {}).items() if isinstance(body, dict) else ():
                    if sha not in known:
                        out.append({"kind": kind, "key": key, "ref": f"asset/{name}", "field": "_assets"})
        return out


# Вложенные транзакции сливаются во внешнюю: BEGIN и COMMIT/ROLLBACK только на первом уровне
class _Transaction:
    def __init__(self, store: ConfigStore):
        self._store = store

    def __enter__(self) -> sqlite3.Connection:
        s = self._store
        s._lock.acquire()
        if s._depth == 0:
            s._db.execute("BEGIN IMMEDIATE")
        s._depth += 1
        return s._db

    def __exit__(self, exc_type, exc, tb) -> None:
        s = self._store
        s._depth -= 1
        try:
            if s._depth == 0:
                s._db.execute("ROLLBACK" if exc_type else "COMMIT")
        finally:
            s._lock.release()


def check_refs(bodies: dict[str, dict[str, Any]]) -> list[dict]:
    broken: list[dict] = []

    def has(kind: str, key: Any) -> bool:
        return isinstance(key, str) and key in bodies.get(kind, {})

    def need(kind: str, key: str, ref_kind: str, ref_key: Any, field: str) -> None:
        if not has(ref_kind, ref_key):
            broken.append({"kind": kind, "key": key, "ref": f"{ref_kind}/{ref_key}", "field": field})

    def items(kind: str):
        return bodies.get(kind, {}).items()

    for key, _ in items("binding"):
        need("binding", key, "place", key, "key")

    for kind in ("camera", "video_stream", "neural_slot", "calibration", "correction_link", "preset", "projection"):
        for key, body in items(kind):
            if body.get("place") is not None:
                need(kind, key, "place", body["place"], "place")
    for key, _ in items("surround_output"):
        need("surround_output", key, "place", key, "key")

    for key, body in items("video_stream"):
        for tile in body.get("tiles") or []:
            need("video_stream", key, "camera", tile.get("camera"), "tiles.camera")
        for config_id, per_camera in (body.get("zones") or {}).items():
            need("video_stream", key, "neural_config", config_id, "zones")
            catalog = {z.get("id") for z in (bodies.get("neural_config", {}).get(config_id) or {}).get("zones") or []}
            for camera_id, polygons in (per_camera or {}).items():
                need("video_stream", key, "camera", camera_id, f"zones.{config_id}")
                for polygon in polygons or []:
                    if has("neural_config", config_id) and polygon.get("zone") not in catalog:
                        broken.append({
                            "kind": "video_stream", "key": key,
                            "ref": f"neural_config/{config_id}/zone/{polygon.get('zone')}",
                            "field": f"zones.{config_id}.{camera_id}",
                        })

    for key, body in items("neural_slot"):
        need("neural_slot", key, "video_stream", body.get("stream_id"), "stream_id")
        need("neural_slot", key, "neural_config", body.get("config_id"), "config_id")

    for key, body in items("correction_link"):
        need("correction_link", key, "camera", key, "key")
        need("correction_link", key, "calibration", body.get("config"), "config")

    for key, body in items("preset"):
        for place, cam in (body.get("cameras") or {}).items():
            if cam.get("camera_id"):
                need("preset", key, "camera", cam["camera_id"], f"cameras.{place}.camera_id")
            if cam.get("calibration"):
                need("preset", key, "calibration", cam["calibration"], f"cameras.{place}.calibration")

    for key, body in items("projection"):
        if body.get("preset"):
            need("projection", key, "preset", body["preset"], "preset")
        for place, cam in (body.get("cameras") or {}).items():
            if cam.get("camera_id"):
                need("projection", key, "camera", cam["camera_id"], f"cameras.{place}.camera_id")
        surround = body.get("surround") or {}
        if surround.get("preset"):
            need("projection", key, "preset", surround["preset"], "surround.preset")
        for camera_id, calib in (surround.get("calibration") or {}).items():
            need("projection", key, "calibration", calib, f"surround.calibration.{camera_id}")

    outputs = set()
    for key, body in items("surround_output"):
        for export_id, cfg in (body.get("configs") or {}).items():
            need("surround_output", key, "projection", export_id, "configs")
            for place, camera_id in (cfg.get("cameras") or {}).items():
                if camera_id:
                    need("surround_output", key, "camera", camera_id, f"configs.{export_id}.cameras.{place}")
            if cfg.get("stream_id"):
                outputs.add(cfg["stream_id"])

    # Виртуальные камеры отображений: выводы слотов и вывод 360
    for body in bodies.get("neural_slot", {}).values():
        outputs.add(f"stream_{body.get('config_id')}_{body.get('stream_id')}")
    viewable = set(bodies.get("camera", {})) | outputs
    for key, body in items("layout"):
        for cell, camera_id in (body.get("activeCells") or {}).items():
            if camera_id and camera_id not in viewable:
                broken.append({"kind": "layout", "key": key, "ref": f"camera/{camera_id}", "field": f"activeCells.{cell}"})
        for field in ("detections", "streams", "corrections"):
            for camera_id in (body.get(field) or {}):
                if camera_id not in viewable:
                    broken.append({"kind": "layout", "key": key, "ref": f"camera/{camera_id}", "field": field})

    for key, body in items("machine"):
        if body.get("active_integration"):
            need("machine", key, "integration", body["active_integration"], "active_integration")
    for key, _ in items("rules"):
        need("rules", key, "integration", key, "key")

    return broken


_store: Optional[ConfigStore] = None


def get_store() -> ConfigStore:
    global _store
    if _store is None:
        _store = ConfigStore(settings.CONFIG_DB, settings.CONFIG_ASSETS_DIR)
    return _store
