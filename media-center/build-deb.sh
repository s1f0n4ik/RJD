#!/usr/bin/env bash
# Сборка media-center_<версия>_arm64.deb из готовой сборки: media-center/build-deb.sh <каталог сборки> <версия> [каталог вывода]

set -euo pipefail

BUILD_DIR="${1:?укажите каталог сборки с бинарником media-center и shaders/}"
VERSION="${2:?укажите версию пакета, например 1.1.0+202611201430.a81b3f0}"
OUT_DIR="${3:-$PWD}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -x "$BUILD_DIR/media-center" ]] || { echo "ОШИБКА: нет $BUILD_DIR/media-center" >&2; exit 1; }
[[ -d "$BUILD_DIR/shaders" ]] || { echo "ОШИБКА: нет $BUILD_DIR/shaders" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/root"

mkdir -p "$ROOT/opt/media-center" "$ROOT/lib/systemd/system" "$ROOT/DEBIAN"
install -m 755 "$BUILD_DIR/media-center" "$ROOT/opt/media-center/media-center"
cp -r "$BUILD_DIR/shaders" "$ROOT/opt/media-center/shaders"
install -m 644 "$SRC/debian/media-center.default" "$ROOT/opt/media-center/media-center.default"
install -m 644 "$SRC/debian/media-center.service" "$ROOT/lib/systemd/system/media-center.service"
sed "s|@VERSION@|$VERSION|" "$SRC/debian/control" > "$ROOT/DEBIAN/control"
install -m 755 "$SRC/debian/postinst" "$SRC/debian/prerm" "$ROOT/DEBIAN/"

mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/media-center_${VERSION}_arm64.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$DEB" >/dev/null
echo "$DEB"
