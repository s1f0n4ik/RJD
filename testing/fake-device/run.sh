#!/usr/bin/env bash
# Поддельная плата техзрения на машине мастера: start | mode <ok|no_module|bare> | offline | online | stop
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${FAKE_CONTAINER:-fake-device}"
ID="${FAKE_ID:-fake-second}"
TITLE="${FAKE_TITLE:-Хвостовой вагон}"
IMAGE="${FAKE_IMAGE:-varan/detection-service:latest}"
API="${FAKE_API:-http://127.0.0.1:8000/api}"
BACKUP="${FAKE_BACKUP:-$HOME/devices.json.bak-fake}"

ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME"; }
registry() { docker exec fastapi cat /data/devices.json; }

case "${1:-}" in
    start)
        if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
            echo "$NAME already exists, run: $0 stop" >&2
            exit 1
        fi
        registry > "$BACKUP"
        # Образ мастера уже несёт FastAPI и uvicorn; сеть — мост docker, fastapi в сети хоста его видит
        docker run --rm -d --name "$NAME" -v "$HERE:/fake:ro" --entrypoint python "$IMAGE" /fake/server.py --id "$ID" >/dev/null
        IP=""
        for _ in $(seq 1 30); do
            IP="$(ip_of)"
            if [ -n "$IP" ] && curl -sf -m 1 "http://$IP:7777/system/info" >/dev/null; then break; fi
            sleep 0.5
        done
        curl -sf -m 5 -X POST "$API/devices" -H 'Content-Type: application/json' \
            -d "{\"id\":\"$ID\",\"ip\":\"$IP\",\"name\":\"$TITLE\",\"modules\":[\"neural\"]}" >/dev/null
        echo "$ID registered at $IP, registry backup: $BACKUP"
        ;;
    mode)
        curl -sf -m 3 -X POST "http://$(ip_of):7777/_mode/${2:?mode: ok | no_module | bare}"
        echo
        ;;
    offline)
        # Пауза держит адрес: online возвращает плату без перерегистрации
        docker pause "$NAME" >/dev/null
        echo "$ID paused"
        ;;
    online)
        docker unpause "$NAME" >/dev/null
        echo "$ID resumed"
        ;;
    stop)
        curl -s -m 5 -X DELETE "$API/devices/$ID" >/dev/null || true
        docker rm -f "$NAME" >/dev/null 2>&1 || true
        if [ -f "$BACKUP" ] && registry | diff -q - "$BACKUP" >/dev/null; then
            echo "registry matches $BACKUP"
        else
            echo "registry differs from $BACKUP, check: docker exec fastapi cat /data/devices.json | diff - $BACKUP" >&2
            exit 1
        fi
        ;;
    *)
        echo "usage: $0 start | mode <ok|no_module|bare> | offline | online | stop" >&2
        exit 2
        ;;
esac
