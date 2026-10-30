import json
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

from app.services.config_store import ConfigError, ConfigStore

FORMAT = 1
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _asset_shas(entities: dict) -> set[str]:
    return {
        sha
        for body in entities.values() if isinstance(body, dict)
        for sha in (body.get("_assets") or {}).values() if sha
    }


def export_profile(store: ConfigStore, profile_id: str, version_id: int | None = None) -> tuple[Path, str]:
    prof = store.profile(profile_id)
    version = store.version(version_id or prof["version_id"])
    if version["profile_id"] != profile_id:
        raise ConfigError(f"version {version['id']} does not belong to {profile_id!r}")
    entities = store.version_entities(version["id"])
    shas = _asset_shas(entities)
    assets = store.assets(shas)
    if shas - assets.keys():
        raise ConfigError(f"profile references missing files: {sorted(shas - assets.keys())}")

    doc = {
        "format": FORMAT,
        "profile": {"id": prof["id"], "name": prof["name"]},
        "version": {k: version[k] for k in ("number", "hash", "label", "created")},
        "entities": [
            {"kind": kind, "key": key, "body": body}
            for (kind, key), body in sorted(entities.items())
        ],
        "assets": assets,
    }
    fd, tmp = tempfile.mkstemp(suffix=".varan")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w") as z:
        z.writestr("profile.json", json.dumps(doc, ensure_ascii=False, indent=1), zipfile.ZIP_DEFLATED)
        # Модели и картинки уже сжаты: кладутся как есть
        for sha in sorted(shas):
            z.write(store.asset_path(sha), f"assets/{sha}", zipfile.ZIP_STORED)
    return Path(tmp), f"{profile_id}-v{version['number']}.varan"


def load_profile(store: ConfigStore, path: Path) -> dict:
    with zipfile.ZipFile(path) as z:
        doc = json.loads(z.read("profile.json"))
        if doc.get("format") != FORMAT:
            raise ConfigError(f"unsupported profile format {doc.get('format')!r}")
        known = store.assets().keys()
        with tempfile.TemporaryDirectory() as tmp:
            for sha, meta in (doc.get("assets") or {}).items():
                if not SHA_RE.match(sha):
                    raise ConfigError(f"bad asset id {sha!r}")
                if sha in known:
                    continue
                part = Path(tmp) / sha
                with z.open(f"assets/{sha}") as src, open(part, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
                if store.put_asset_file(part, meta.get("name") or sha, meta.get("info")) != sha:
                    raise ConfigError(f"asset {sha} is corrupted")
                part.unlink()

    profile = doc["profile"]
    entities = {(e["kind"], e["key"]): e["body"] for e in doc["entities"]}
    missing = _asset_shas(entities) - store.assets().keys()
    if missing:
        raise ConfigError(f"profile file lacks referenced files: {sorted(missing)}")
    label = f"файл v{doc['version']['number']}"
    version = store.create_version(profile["id"], profile["name"], entities, label=label)
    return {"profile": profile, "version": version, "source": doc["version"]}
