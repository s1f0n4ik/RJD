#!/bin/sh
# Резервная копия конфигураций платы: sudo sh backup-config.sh [корень varan] [каталог вывода]
set -eu

ROOT=${1:-/var/lib/varan}
OUT=${2:-$(pwd)}
HOST=$(hostname)
NAME="varan-backup-$HOST-$(date +%Y-%m-%d-%H%M%S)"
TMP=$(mktemp -d)
DST="$TMP/$NAME"
trap 'rm -rf "$TMP"' EXIT

[ -d "$ROOT" ] || { echo "varan root not found: $ROOT" >&2; exit 1; }
mkdir -p "$DST/varan" "$DST/master" "$DST/gateway" "$DST/journal" "$DST/storage"

# Источник монтирования каталога внутри контейнера, пусто без docker или контейнера
mount_of() {
	docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" 2>/dev/null || true
}

copy_if() {
	if [ -e "$1" ]; then cp -a "$1" "$2/"; fi
}

tar -C "$ROOT" --exclude=./logs --exclude=./records -cf - . | tar -C "$DST/varan" -xf -

MASTER_DATA=$(mount_of fastapi /data)
[ -n "$MASTER_DATA" ] || MASTER_DATA="$ROOT/settings"
if [ -d "$MASTER_DATA" ]; then cp -a "$MASTER_DATA/." "$DST/master/"; fi

GATEWAY_DATA=$(mount_of message-gateway /data)
[ -n "$GATEWAY_DATA" ] && copy_if "$GATEWAY_DATA/gateway-state.json" "$DST/gateway"

JOURNAL=$(docker inspect detection-service --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^JOURNAL_DIR=//p')
[ -n "$JOURNAL" ] || JOURNAL=/storage/journal
copy_if "$JOURNAL/rules" "$DST/journal"
copy_if "$JOURNAL/master-state.json" "$DST/journal"

copy_if /storage/archive/pool.json "$DST/storage"

MACS=""
for n in /sys/class/net/*; do
	[ -e "$n/device" ] || continue
	MACS="$MACS\"$(basename "$n")=$(cat "$n/address")\","
done
INFO=$(curl -s --max-time 3 http://127.0.0.1:7777/system/info 2>/dev/null || true)
[ -n "$INFO" ] || INFO=null
cat > "$DST/meta.json" <<EOF
{
  "format": 1,
  "host": "$HOST",
  "created": "$(date -Iseconds)",
  "varan_root": "$ROOT",
  "machine_id": "$(cat /etc/machine-id)",
  "macs": [${MACS%,}],
  "master_data": "$MASTER_DATA",
  "journal_dir": "$JOURNAL",
  "system_info": $INFO
}
EOF

mkdir -p "$OUT"
tar -C "$TMP" -czf "$OUT/$NAME.tar.gz" "$NAME"
echo "$OUT/$NAME.tar.gz"
