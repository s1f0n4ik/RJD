#!/usr/bin/env python3
# Упаковка файла обновления: образы ролей без слоёв базы, манифест и итоговый tar; запускает build-update.sh
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import tarfile
import time
from pathlib import Path

ROLES = ("minion", "master")
ROLE_FILES = ("images.tar.gz", "docker-compose.yml", ".env.example", "install.sh", "rollback.sh")


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def content_hash(root: Path, paths: list[Path]) -> str:
    # Содержимое без времени сборки: тот же код даёт тот же хеш, даже если .deb собран заново
    digest = hashlib.sha256()
    for path in sorted(p for p in paths if p.is_file()):
        digest.update(str(path.relative_to(root)).replace("\\", "/").encode())
        digest.update(sha_file(path).encode())
    return digest.hexdigest()


def strip_images(src: Path, dest: Path, known: set[str]) -> list[dict]:
    # Слой из базы этой роли на плате уже есть: его blob выбрасывается, остальное содержимое docker save остаётся как есть
    with tarfile.open(src) as archive:
        entries = json.load(archive.extractfile("manifest.json"))
        images, skip = [], set()
        for entry in entries:
            diff_ids = json.load(archive.extractfile(entry["Config"]))["rootfs"]["diff_ids"]
            if len(diff_ids) != len(entry["Layers"]):
                raise SystemExit(f"{entry['RepoTags']}: {len(entry['Layers'])} layers, {len(diff_ids)} diff_ids")
            shipped = []
            for path, diff_id in zip(entry["Layers"], diff_ids):
                if diff_id in known:
                    skip.add(path)
                else:
                    shipped.append(diff_id)
            images.append({"name": entry["RepoTags"][0], "layers": diff_ids, "shipped": shipped})
        with gzip.open(dest, "wb", compresslevel=6) as packed, tarfile.open(fileobj=packed, mode="w|") as out:
            for member in archive.getmembers():
                if member.name not in skip:
                    out.addfile(member, archive.extractfile(member) if member.isfile() else None)
    return images


def main() -> None:
    parser = argparse.ArgumentParser(description="Pack a VARAN update file from a prepared stage directory")
    parser.add_argument("--stage", required=True, help="dir with minion/ and master/ (images.tar from docker save + files), media-center.deb, updater.deb")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--base-manifest", default="", help="manifest.json of the base release; empty for a full file")
    parser.add_argument("--mc-dir", required=True, help="media-center build dir (binary + shaders/)")
    parser.add_argument("--updater-dir", required=True, help="updater/ source dir")
    parser.add_argument("--updater-version", required=True)
    parser.add_argument("--out", required=True, help="path of the resulting .tar")
    args = parser.parse_args()

    stage = Path(args.stage)
    base = json.loads(Path(args.base_manifest).read_text(encoding="utf-8")) if args.base_manifest else None
    images = {}
    for role in ROLES:
        known = {diff_id for image in ((base or {}).get("images") or {}).get(role, []) for diff_id in image["layers"]}
        images[role] = strip_images(stage / role / "images.tar", stage / role / "images.tar.gz", known)
        (stage / role / "images.tar").unlink()

    mc_dir, updater_dir = Path(args.mc_dir), Path(args.updater_dir)
    contents = {
        "media-center": content_hash(mc_dir, [mc_dir / "media-center", *(mc_dir / "shaders").rglob("*")]),
        "varan-updater": content_hash(updater_dir, list((updater_dir / "app").rglob("*.py"))),
    }
    before = {c["name"]: c.get("content") for c in (base or {}).get("components") or []}
    components = [{"name": image["name"].split("/", 1)[-1].rsplit(":", 1)[0], "role": role, "changed": not base or bool(image["shipped"])}
                  for role in ROLES for image in images[role]]
    components += [{"name": name, "role": "minion" if name == "media-center" else "all", "changed": before.get(name) != content, "content": content}
                   for name, content in contents.items()]

    parts = [(f"{role}/{name}", role) for role in ROLES for name in ROLE_FILES]
    parts += [("media-center.deb", "minion"), ("updater.deb", "all")]
    manifest = {
        "format": 1, "tag": args.tag, "base": base["tag"] if base else "", "updater_version": args.updater_version,
        "created": time.time(), "components": components, "images": images,
        "parts": [{"path": path, "role": role, "size": (stage / path).stat().st_size, "sha256": sha_file(stage / path)} for path, role in parts],
    }
    (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    # manifest.json первым: мастер разбирает файл потоком и сверяет каждую часть по нему
    with tarfile.open(args.out, "w") as out:
        out.add(stage / "manifest.json", "manifest.json")
        for part in manifest["parts"]:
            out.add(stage / part["path"], part["path"])

    changed = [c["name"] for c in components if c["changed"]]
    layers = sum(len(image["shipped"]) for role in ROLES for image in images[role])
    print(f"components changed {len(changed)} of {len(components)}: {', '.join(changed) or 'none'}; layers shipped: {layers}")


if __name__ == "__main__":
    main()
