import copy
import json
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Optional

from app.services.config_store import ConfigStore, canon

# Поля, которые плата пересчитывает сама при применении
NEURAL_DERIVED = ("model", "model_path")
CALIBRATION_DERIVED = ("undist_map_x", "undist_map_y")
PROJECTION_DERIVED = ("versions", "active_version")
PROJECTION_CAMERA_DERIVED = ("remap", "weight")
# Состояние экрана, а не машины
OUTPUT_RUNTIME = ("view_mode",)


def _read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _extract(archive: Path, dest: Path) -> Path:
    dest.mkdir(parents=True)
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(dest, filter="data")
    roots = [p.parent for p in dest.glob("*/meta.json")]
    if len(roots) != 1:
        raise ValueError(f"{archive.name}: expected one backup root with meta.json, found {len(roots)}")
    return roots[0]


class _Import:
    def __init__(self, store: ConfigStore):
        self.store = store
        self.entities: dict[tuple[str, str], Any] = {}
        self.origin: dict[tuple[str, str], str] = {}
        self.bindings: dict[str, dict] = {}
        self.places: list[dict] = []
        self.collisions: list[dict] = []
        self.warnings: list[str] = []

    def add(self, kind: str, key: str, body: Any, origin: str) -> None:
        ident = (kind, key)
        if ident in self.entities:
            if canon(self.entities[ident]) != canon(body):
                self.collisions.append({"kind": kind, "key": key, "kept": self.origin[ident], "dropped": origin})
            return
        self.entities[ident] = body
        self.origin[ident] = origin

    def result(self) -> dict:
        return {
            "entities": self.entities, "bindings": self.bindings, "places": self.places,
            "collisions": self.collisions, "warnings": self.warnings,
        }


class _Board:
    def __init__(self, imp: _Import, root: Path, number: int, registry: list[dict]):
        self.imp = imp
        self.root = root
        self.varan = root / "varan"
        self.meta = _read_json(root / "meta.json", {})
        self.vroot = PurePosixPath(self.meta.get("varan_root") or "/var/lib/varan")
        self.host = self.meta.get("host") or root.name
        self.place = f"board-{number}"
        machine_id = self.meta.get("machine_id", "")
        self.device = next((d for d in registry if d.get("id", "").startswith(machine_id + "-")), None)

    def device_id(self) -> str:
        if self.device:
            return self.device["id"]
        macs = self.meta.get("macs") or []
        mac = macs[0].split("=", 1)[-1].replace(":", "") if macs else ""
        return f"{self.meta.get('machine_id', '')}-{mac}"

    def resolve(self, path: Optional[str], fallback_dir: Path, name: Optional[str] = None) -> Optional[Path]:
        if path:
            p = PurePosixPath(path)
            if p.is_absolute():
                try:
                    candidate = self.varan / p.relative_to(self.vroot)
                    if candidate.is_file():
                        return candidate
                except ValueError:
                    pass
            name = name or p.name
        if name and (fallback_dir / name).is_file():
            return fallback_dir / name
        return None

    def asset(self, body: dict, file: Optional[Path], name: str, what: str, info: Optional[dict] = None) -> None:
        assets = body.setdefault("_assets", {})
        if file is None:
            assets[name] = None
            self.imp.warnings.append(f"{self.host}: {what}: file {name!r} is missing in the backup")
            return
        assets[name] = self.imp.store.put_asset_file(file, name, info)

    def add(self, kind: str, key: str, body: Any) -> None:
        self.imp.add(kind, key, body, self.host)

    def read(self) -> None:
        device = self.device or {}
        info = self.meta.get("system_info") or {}
        self.imp.places.append({"place": self.place, "device_id": self.device_id(), "host": self.host})
        self.add("place", self.place, {
            "name": device.get("name") or self.host,
            "modules": device.get("modules") or info.get("modules") or [],
        })
        self.imp.bindings[self.place] = {"device_id": self.device_id()}
        self.read_cameras()
        self.read_neural()
        self.read_surround()
        self.read_master()

    def read_cameras(self) -> None:
        nvr = _read_json(self.varan / "nvr" / "configurations.json", {})
        for entry in nvr.get("cameras", []):
            camera_id = (entry.get("camera") or {}).get("id")
            if not camera_id or camera_id.startswith("__probe_"):
                continue
            self.add("camera", camera_id, {"place": self.place, **entry})

    def read_neural(self) -> None:
        neural = self.varan / "neural"
        for config_id, cfg in (_read_json(neural / "configurations.json", {}) or {}).items():
            body = {k: copy.deepcopy(v) for k, v in cfg.items() if k not in NEURAL_DERIVED}
            model_path = cfg.get("model_path")
            if model_path:
                name = PurePosixPath(model_path).name
                body["model_file"] = name
                file = self.resolve(model_path, neural / "models")
                self.asset(body, file, name, f"neural_config/{config_id}", cfg.get("model"))
            self.add("neural_config", config_id, body)

        for stream_id, stream in (_read_json(neural / "streams.json", {}) or {}).items():
            self.add("video_stream", stream_id, {"place": self.place, **stream})

        # Слот — пара видеопоток и конфигурация
        for slot in _read_json(neural / "loader_state.json", []) or []:
            self.add("neural_slot", f"{slot.get('stream_id')}|{slot.get('config_id')}", {"place": self.place, **slot})

    def read_surround(self) -> None:
        sv = self.varan / "surround_view"
        for key, rec in (_read_json(sv / "calibration" / "calibration_settings.json", {}) or {}).items():
            body = {k: v for k, v in rec.items() if k not in CALIBRATION_DERIVED}
            self.add("calibration", key, {"place": self.place, **body})

        for camera_id, link in (_read_json(sv / "calibration" / "links.json", {}) or {}).items():
            # Старый формат связи — строка с ключом калибровки
            link = {"config": link} if isinstance(link, str) else link
            self.add("correction_link", camera_id, {"place": self.place, **link})

        images_dir = sv / "presets" / "images"
        models_dir = sv / "presets" / "models"
        for key, preset in (_read_json(sv / "presets" / "presets.json", {}) or {}).items():
            body = copy.deepcopy(preset)
            self.images(body, images_dir, f"preset/{key}")
            self.add("preset", key, {"place": self.place, **body})

        for key, export in (_read_json(sv / "projection" / "projection.json", {}) or {}).items():
            body = {k: copy.deepcopy(v) for k, v in export.items() if k not in PROJECTION_DERIVED}
            for cam in (body.get("cameras") or {}).values():
                for field in PROJECTION_CAMERA_DERIVED:
                    cam.pop(field, None)
            self.images(body, images_dir, f"projection/{key}")
            for block in ("surround", "top"):
                source = ((body.get(block) or {}).get("model") or {}).get("source")
                if source and source not in (body.get("_assets") or {}):
                    self.asset(body, self.resolve(None, models_dir, source), source, f"projection/{key}")
            self.add("projection", key, {"place": self.place, **body})

        state = _read_json(sv / "linker" / "state.json")
        if state:
            configs = {
                export_id: {k: v for k, v in cfg.items() if k not in OUTPUT_RUNTIME}
                for export_id, cfg in (state.get("configs") or {}).items()
            }
            self.add("surround_output", self.place, {"active": state.get("active"), "configs": configs})

    def images(self, body: dict, images_dir: Path, what: str) -> None:
        for image in body.get("images") or []:
            name = image.get("name") or PurePosixPath(image.get("path") or "").name
            if not name:
                continue
            image["name"] = name
            self.asset(body, self.resolve(image.pop("path", None), images_dir, name), name, what)

    def read_master(self) -> None:
        for layout in _read_json(self.root / "master" / "layouts.json", []) or []:
            if layout.get("name"):
                self.add("layout", layout["name"], layout)

        settings: dict[str, Any] = {}
        gateway = _read_json(self.root / "gateway" / "gateway-state.json")
        if gateway:
            for integration_id, integration in (gateway.get("integrations") or {}).items():
                self.add("integration", integration_id, integration)
            if gateway.get("active"):
                settings["active_integration"] = gateway["active"]
            tz = (gateway.get("time") or {}).get("tz_offset_min")
            if tz is not None:
                settings["tz_offset_min"] = tz

        journal = self.root / "journal"
        state = _read_json(journal / "master-state.json") or {}
        if state.get("active_integration") and "active_integration" not in settings:
            settings["active_integration"] = state["active_integration"]
        for rules in sorted((journal / "rules").glob("*.json")):
            self.add("rules", rules.stem, _read_json(rules))

        if settings:
            self.add("machine", "settings", settings)


def import_backups(store: ConfigStore, archives: list[Path]) -> dict:
    imp = _Import(store)
    with tempfile.TemporaryDirectory() as tmp:
        roots = [_extract(a, Path(tmp) / str(i)) for i, a in enumerate(archives)]
        registry: list[dict] = []
        for root in roots:
            registry += (_read_json(root / "master" / "devices.json", {}) or {}).get("devices", [])
        for number, root in enumerate(roots, 1):
            _Board(imp, root, number, registry).read()
    return imp.result()
