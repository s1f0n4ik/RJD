import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "updater"))

from app import package


def blob(data: bytes) -> tuple[str, bytes]:
    return hashlib.sha256(data).hexdigest(), data


def docker_save(path: Path, images: dict[str, list[bytes]]) -> None:
    # Сохранение в раскладке docker save 25+: blobs/sha256/<digest>, manifest.json, index.json
    files, entries = {"oci-layout": b'{"imageLayoutVersion": "1.0.0"}', "index.json": b'{"manifests": []}'}, []
    for name, layers in images.items():
        digests = [blob(layer) for layer in layers]
        config = blob(json.dumps({"rootfs": {"type": "layers", "diff_ids": [f"sha256:{d}" for d, _ in digests]}}).encode())
        for digest, data in digests + [config]:
            files[f"blobs/sha256/{digest}"] = data
        entries.append({"Config": f"blobs/sha256/{config[0]}", "RepoTags": [name], "Layers": [f"blobs/sha256/{d}" for d, _ in digests]})
    files["manifest.json"] = json.dumps(entries).encode()
    with tarfile.open(path, "w") as out:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            out.addfile(info, io.BytesIO(data))


def stage(root: Path, tag: str, images: dict[str, dict[str, list[bytes]]], updater_code: str) -> tuple[Path, Path, Path]:
    stage_dir, mc_dir, updater_dir = root / f"stage-{tag}", root / f"mc-{tag}", root / f"updater-{tag}"
    for role, role_images in images.items():
        (stage_dir / role).mkdir(parents=True)
        docker_save(stage_dir / role / "images.tar", {f"varan/{name}:{tag}": layers for name, layers in role_images.items()})
        for name in ("docker-compose.yml", ".env.example", "install.sh", "rollback.sh"):
            (stage_dir / role / name).write_text(f"{role} {name} {tag}\n", encoding="utf-8")
    (stage_dir / "media-center.deb").write_bytes(b"mc deb " + tag.encode())
    (stage_dir / "updater.deb").write_bytes(b"updater deb " + tag.encode())
    (mc_dir / "shaders").mkdir(parents=True)
    (mc_dir / "media-center").write_bytes(b"\x7fELF same binary")
    (mc_dir / "shaders" / "nv12.frag").write_text("void main() {}\n", encoding="utf-8")
    (updater_dir / "app").mkdir(parents=True)
    (updater_dir / "app" / "master.py").write_text(updater_code, encoding="utf-8")
    return stage_dir, mc_dir, updater_dir


def pack(stage_dir: Path, mc_dir: Path, updater_dir: Path, tag: str, base: str, out: Path) -> dict:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "update-pack.py"), "--stage", str(stage_dir), "--tag", tag,
                    "--base-manifest", base, "--mc-dir", str(mc_dir), "--updater-dir", str(updater_dir),
                    "--updater-version", f"1.0.0+{tag}", "--out", str(out)], check=True)
    return json.loads((stage_dir / "manifest.json").read_text(encoding="utf-8"))


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        python, pip, nginx = os.urandom(300_000), os.urandom(200_000), os.urandom(100_000)
        app, signal = b"app code v1", b"signal code"
        first = {"minion": {"storage-service": [python, pip, app], "signaling-server": [python, signal]},
                 "master": {"fastapi": [python, app], "frontend": [nginx, b"bundle v1"]}}
        base_tag = "2026-11-06-0900-4f2c9e1"
        out_full = root / "full.tar"
        full = pack(*stage(root, base_tag, first, "v1"), base_tag, "", out_full)
        assert full["base"] == "" and all(c["changed"] for c in full["components"]), full["components"]
        assert all(image["shipped"] == image["layers"] for role in full["images"].values() for image in role)
        with tarfile.open(out_full) as archive:
            assert archive.getnames()[0] == "manifest.json", archive.getnames()[:3]

        # Готовый файл проходит потоковый разбор службы обновления
        unpacked = root / "unpacked"
        with out_full.open("rb") as f:
            got = package.unpack(f.read, unpacked)
        assert got["tag"] == base_tag and (unpacked / "minion" / "images.tar.gz").is_file()

        base_manifest = root / "base-manifest.json"
        base_manifest.write_text(json.dumps(full), encoding="utf-8")
        second = {"minion": {"storage-service": [python, pip, b"app code v2"], "signaling-server": [python, signal]},
                  "master": {"fastapi": [python, b"app code v2"], "frontend": [nginx, b"bundle v1"]}}
        tag = "2026-11-20-1430-a81b3f0"
        out_delta = root / "delta.tar"
        delta = pack(*stage(root, tag, second, "v2"), tag, str(base_manifest), out_delta)
        assert delta["base"] == base_tag
        changed = {c["name"]: c["changed"] for c in delta["components"]}
        assert changed == {"storage-service": True, "signaling-server": False, "fastapi": True, "frontend": False,
                           "media-center": False, "varan-updater": True}, changed
        shipped = {image["name"]: image["shipped"] for role in delta["images"].values() for image in role}
        new_app = f"sha256:{hashlib.sha256(b'app code v2').hexdigest()}"
        assert shipped[f"varan/storage-service:{tag}"] == [new_app] and shipped[f"varan/signaling-server:{tag}"] == [], shipped
        assert shipped[f"varan/fastapi:{tag}"] == [new_app] and shipped[f"varan/frontend:{tag}"] == []

        # В архиве роли нет blob'ов базы, но описания образов и новые слои на месте
        with gzip.open(root / f"stage-{tag}" / "minion" / "images.tar.gz") as packed, tarfile.open(fileobj=packed, mode="r|") as archive:
            names = {member.name for member in archive}
        assert f"blobs/sha256/{hashlib.sha256(pip).hexdigest()}" not in names and f"blobs/sha256/{hashlib.sha256(python).hexdigest()}" not in names
        assert f"blobs/sha256/{new_app.split(':')[1]}" in names and {"manifest.json", "index.json", "oci-layout"} <= names
        assert out_delta.stat().st_size < out_full.stat().st_size
        with out_delta.open("rb") as f:
            assert package.unpack(f.read, root / "unpacked-delta")["base"] == base_tag
    print("update-pack-check: OK")


main()
