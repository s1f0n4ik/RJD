from __future__ import annotations

import hashlib
import json
import os
import re
import tarfile
from pathlib import Path
from typing import Callable

from app.web import CHUNK

FORMAT = 1
PART_ROLES = ("minion", "master", "all")
_SEGMENT = re.compile(r"^[A-Za-z0-9_.+-]+$")


class PackageError(Exception):
    pass


def _safe_path(path: object) -> str:
    segments = str(path).split("/") if isinstance(path, str) else []
    if not 1 <= len(segments) <= 2 or any(not _SEGMENT.match(s) or s in (".", "..") for s in segments):
        raise PackageError(f"Bad part path: {path!r}")
    return "/".join(segments)


def check_manifest(manifest: object) -> dict:
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise PackageError(f"Unsupported manifest, format {FORMAT} expected")
    tag, base = manifest.get("tag"), manifest.get("base", "")
    if not isinstance(tag, str) or not _SEGMENT.match(tag) or not isinstance(base, str) or (base and not _SEGMENT.match(base)):
        raise PackageError("Manifest tag or base is invalid")
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not parts:
        raise PackageError("Manifest has no parts")
    seen = set()
    for part in parts:
        if not isinstance(part, dict) or part.get("role") not in PART_ROLES:
            raise PackageError(f"Bad part: {part!r}")
        part["path"] = _safe_path(part.get("path"))
        if part["path"] in seen or part["path"] == "manifest.json":
            raise PackageError(f"Duplicate part: {part['path']}")
        seen.add(part["path"])
        if not isinstance(part.get("size"), int) or part["size"] < 0 or not re.match(r"^[0-9a-f]{64}$", str(part.get("sha256"))):
            raise PackageError(f"Part {part['path']} has no size or sha256")
    return manifest


def parts_for(manifest: dict, roles: list[str]) -> list[dict]:
    return [part for part in manifest["parts"] if part["role"] == "all" or part["role"] in roles]


def roles_of(manifest: dict) -> list[str]:
    return [role for role in ("minion", "master") if any(part["role"] == role for part in manifest["parts"])]


def receive(read: Callable[[int], bytes], length: int, dest: Path, part: dict) -> None:
    if length != part["size"]:
        raise PackageError(f"Part {part['path']}: size {length}, manifest says {part['size']}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    digest = hashlib.sha256()
    left = length
    try:
        with tmp.open("wb") as f:
            while left > 0:
                chunk = read(min(CHUNK, left))
                if not chunk:
                    break
                digest.update(chunk)
                f.write(chunk)
                left -= len(chunk)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    if left or digest.hexdigest() != part["sha256"]:
        tmp.unlink(missing_ok=True)
        raise PackageError(f"Part {part['path']}: sha256 mismatch")
    os.replace(tmp, dest)


class _Reader:
    def __init__(self, read: Callable[[int], bytes]):
        self._read = read

    def read(self, size: int = -1) -> bytes:
        return self._read(size)


def unpack(read: Callable[[int], bytes], dest: Path) -> dict:
    # Файл идёт потоком: manifest.json первым, затем части, каждая сверяется с манифестом
    manifest = None
    parts: dict[str, dict] = {}
    got: set[str] = set()
    try:
        with tarfile.open(fileobj=_Reader(read), mode="r|") as archive:
            for member in archive:
                name = member.name[2:] if member.name.startswith("./") else member.name
                if member.isdir() or name in ("", "."):
                    continue
                if not member.isfile():
                    raise PackageError(f"Unexpected entry in the file: {name}")
                source = archive.extractfile(member)
                if manifest is None:
                    if name != "manifest.json":
                        raise PackageError("manifest.json must be the first entry")
                    manifest = check_manifest(json.loads(source.read(1 << 20)))
                    parts = {part["path"]: part for part in manifest["parts"]}
                    continue
                part = parts.get(name)
                if part is None or name in got:
                    raise PackageError(f"Entry {name} is not in the manifest")
                receive(source.read, member.size, dest / name, part)
                got.add(name)
    except (tarfile.TarError, ValueError) as e:
        raise PackageError(f"Not a valid update file: {e}") from None
    if manifest is None:
        raise PackageError("The file has no manifest.json")
    missing = sorted(parts.keys() - got)
    if missing:
        raise PackageError(f"Parts missing from the file: {', '.join(missing)}")
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return manifest
