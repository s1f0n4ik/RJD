# Контейнер модели .rjdm: ZIP без сжатия с manifest.json и weights.rknn, формат — «Формат модели RJDM.md»
import hashlib
import json
import re
import unicodedata
import zipfile
from pathlib import Path
from typing import Any, Optional

SCHEMA_VERSION = 1
MANIFEST = "manifest.json"
WEIGHTS = "weights.rknn"
MANIFEST_MAX_BYTES = 1 << 20
# Цвет, когда его нет ни у класса, ни у суперкласса
SUPERCLASS_COLOR = "#878c97"
CLASS_COLOR = "#68a5ff"

LAYOUTS = {"detect": {"single", "split_levels"}, "segment": {"single_seg", "split_levels_seg"}}
SLUG = re.compile(r"[a-z0-9_-]+")
KEY = re.compile(r"[a-z0-9_]+")
COLOR = re.compile(r"#[0-9a-fA-F]{6}")
SHA256 = re.compile(r"[0-9a-f]{64}")


def _text(source: dict, field: str, limit: int, *, required: bool = False, multiline: bool = False, where: str = "") -> str:
    value = source.get(field)
    label = f"{where}{field}"
    if value is None:
        if required:
            raise ValueError(f"{label} is required")
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    value = unicodedata.normalize("NFC", value).strip()
    if required and not value:
        raise ValueError(f"{label} is empty")
    if len(value) > limit:
        raise ValueError(f"{label} is longer than {limit} characters")
    if any(unicodedata.category(c) == "Cc" and not (multiline and c == "\n") for c in value):
        raise ValueError(f"{label} has control characters")
    return value


def _slug(source: dict, field: str, pattern: re.Pattern, limit: int, *, required: bool = False, where: str = "") -> str:
    value = _text(source, field, limit, required=required, where=where)
    if value and not pattern.fullmatch(value):
        raise ValueError(f"{where}{field} must match {pattern.pattern}")
    return value


def _int(source: dict, field: str, *, minimum: int, where: str = "") -> int:
    value = source.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ValueError(f"{where}{field} must be an integer >= {minimum}")
    return value


def _color(source: dict, where: str) -> str:
    value = _text(source, "color", 7, where=where)
    if value and not COLOR.fullmatch(value):
        raise ValueError(f"{where}color must be #RRGGBB")
    return value


def _object(source: dict, field: str) -> dict:
    value = source.get(field)
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    return value


def _array(source: dict, field: str) -> list:
    value = source.get(field)
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    return value


def _sha256(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    digest = hashlib.sha256()
    with archive.open(info) as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _entries(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    found = {i.filename: i for i in archive.infolist()}
    for name in (MANIFEST, WEIGHTS):
        info = found.get(name)
        if info is None:
            raise ValueError(f"{name} is missing in the archive")
        if info.compress_type != zipfile.ZIP_STORED:
            raise ValueError(f"{name} must be stored without compression")
        if info.flag_bits & 0x1:
            raise ValueError(f"{name} is encrypted")
    return found


def parse_manifest(manifest: Any, weights_size: int, weights_sha256: str) -> dict:
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    if manifest.get("format") != "rjdm":
        raise ValueError("format must be 'rjdm'")
    version = manifest.get("schema_version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ValueError("schema_version must be an integer >= 1")
    if version > SCHEMA_VERSION:
        raise ValueError(f"schema_version {version} is newer than supported {SCHEMA_VERSION}")

    weights = _object(manifest, "weights")
    if weights.get("file") != WEIGHTS:
        raise ValueError(f"weights.file must be '{WEIGHTS}'")
    if weights.get("size") != weights_size:
        raise ValueError(f"weights.size {weights.get('size')} differs from the file ({weights_size})")
    declared = _text(weights, "sha256", 64, required=True, where="weights.")
    if not SHA256.fullmatch(declared):
        raise ValueError("weights.sha256 must be 64 lowercase hex digits")
    if declared != weights_sha256:
        raise ValueError("weights.sha256 differs from the file")
    if not isinstance(weights.get("quantized"), bool):
        raise ValueError("weights.quantized must be a boolean")

    model = _object(manifest, "model")
    task = model.get("task")
    if task not in LAYOUTS:
        raise ValueError("model.task must be 'detect' or 'segment'")
    layout = model.get("output_layout")
    if layout not in LAYOUTS[task]:
        raise ValueError(f"model.output_layout must be one of {sorted(LAYOUTS[task])} for {task}")
    class_count = _int(model, "class_count", minimum=1, where="model.")

    superclasses: dict[str, dict[str, str]] = {}
    for i, item in enumerate(_array(manifest, "superclasses")):
        where = f"superclasses[{i}]."
        if not isinstance(item, dict):
            raise ValueError(f"superclasses[{i}] must be an object")
        key = _slug(item, "key", KEY, 64, required=True, where=where)
        if key in superclasses:
            raise ValueError(f"{where}key '{key}' is duplicated")
        superclasses[key] = {
            "name": _text(item, "name", 120, required=True, where=where),
            "color": _color(item, where) or SUPERCLASS_COLOR,
        }

    entries = _array(manifest, "classes")
    if len(entries) != class_count:
        raise ValueError(f"model.class_count {class_count} differs from the number of classes ({len(entries)})")
    classes: dict[str, dict[str, str]] = {}
    names: set[str] = set()
    for i, item in enumerate(entries):
        where = f"classes[{i}]."
        if not isinstance(item, dict):
            raise ValueError(f"classes[{i}] must be an object")
        class_id = _int(item, "id", minimum=0, where=where)
        if class_id >= class_count or str(class_id) in classes:
            raise ValueError(f"{where}id {class_id} is out of 0..{class_count - 1} or duplicated")
        name = _text(item, "name", 120, required=True, where=where)
        if name in names:
            raise ValueError(f"{where}name '{name}' is duplicated")
        names.add(name)
        superclass = _slug(item, "superclass", KEY, 64, where=where)
        if superclass and superclass not in superclasses:
            raise ValueError(f"{where}superclass '{superclass}' is not in superclasses")
        classes[str(class_id)] = {
            "name": name,
            "server_id": _slug(item, "server_id", SLUG, 64, where=where),
            "superclass": superclass,
            "color": _color(item, where) or (superclasses[superclass]["color"] if superclass else CLASS_COLOR),
        }

    return {
        "id": _slug(manifest, "id", SLUG, 64, required=True),
        "name": _text(manifest, "name", 120, required=True),
        "version": _text(manifest, "version", 32),
        "description": _text(manifest, "description", 2000, multiline=True),
        "author": _text(manifest, "author", 120),
        "created_at": _text(manifest, "created_at", 40),
        "notes": _text(manifest, "notes", 4000, multiline=True),
        "task": task,
        "family": _text(model, "family", 40, where="model."),
        "target_platform": _text(weights, "target_platform", 40, required=True, where="weights."),
        "toolkit_version": _text(weights, "toolkit_version", 40, where="weights."),
        "quantized": weights["quantized"],
        "input_width": _int(model, "input_width", minimum=1, where="model."),
        "input_height": _int(model, "input_height", minimum=1, where="model."),
        "input_channels": _int(model, "input_channels", minimum=1, where="model.") if "input_channels" in model else 3,
        "output_layout": layout,
        "class_count": class_count,
        "weight_bytes": weights_size,
        "weights_sha256": weights_sha256,
        "superclasses": superclasses,
        "classes": classes,
    }


def read_package(path: Path) -> dict:
    """Проверенное описание модели из .rjdm; ValueError с причиной, если файл не годится. Веса не загружаются."""
    try:
        with zipfile.ZipFile(path) as archive:
            found = _entries(archive)
            if found[MANIFEST].file_size > MANIFEST_MAX_BYTES:
                raise ValueError(f"{MANIFEST} is larger than {MANIFEST_MAX_BYTES} bytes")
            try:
                manifest = json.loads(archive.read(MANIFEST).decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as e:
                raise ValueError(f"{MANIFEST} is not UTF-8 JSON without BOM: {e}")
            return parse_manifest(manifest, found[WEIGHTS].file_size, _sha256(archive, found[WEIGHTS]))
    except zipfile.BadZipFile:
        raise ValueError("not a ZIP archive")


def asset_info(package: dict) -> dict:
    """Запись info ассета: размер входа читает проверка потоков и слотов, описание — экран конфигураций"""
    return {
        "input_width": package["input_width"],
        "input_height": package["input_height"],
        "class_count": package["class_count"],
        "quantized": package["quantized"],
        "weight_bytes": package["weight_bytes"],
        "package": package,
    }


def package_of(info: Optional[dict]) -> Optional[dict]:
    package = (info or {}).get("package")
    return package if isinstance(package, dict) else None
