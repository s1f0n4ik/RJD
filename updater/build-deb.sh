#!/usr/bin/env bash
# Сборка varan-updater_<версия>_all.deb: updater/build-deb.sh <версия> [каталог вывода]

set -euo pipefail

VERSION="${1:?укажите версию пакета, например 1.0.0+202611201430.a81b3f0}"
OUT_DIR="${2:-$PWD}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/root"

mkdir -p "$ROOT/opt/varan-updater" "$ROOT/lib/systemd/system" "$ROOT/DEBIAN"
cp -r "$SRC/app" "$ROOT/opt/varan-updater/app"
find "$ROOT" -name __pycache__ -prune -exec rm -rf {} +
printf '%s\n' "$VERSION" > "$ROOT/opt/varan-updater/VERSION"

cp "$SRC"/debian/*.service "$ROOT/lib/systemd/system/"
sed "s|@VERSION@|$VERSION|" "$SRC/debian/control" > "$ROOT/DEBIAN/control"
install -m 755 "$SRC/debian/postinst" "$SRC/debian/prerm" "$ROOT/DEBIAN/"

mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/varan-updater_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$DEB" >/dev/null
echo "$DEB"
