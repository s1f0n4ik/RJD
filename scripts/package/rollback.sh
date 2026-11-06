#!/usr/bin/env bash
# Откат на предыдущую версию: меняет местами TAG и PREV_TAG и перезапускает
# сервисы уже загруженными образами. Сеть и пакет на устройстве не нужны.
#
#   sudo /opt/varan-<роль>/rollback.sh             переключиться на предыдущую версию
#   sudo /opt/varan-<роль>/rollback.sh --to=<тег>  оказаться на версии <тег>: текущая — только поднять сервисы
#
# Повторный запуск без --to возвращает обратно: скрипт переключает две версии между собой.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

HEALTH_TIMEOUT=180

TO=""
for arg in "$@"; do
	case "$arg" in
		--to=*) TO="${arg#*=}" ;;
		*) echo "ОШИБКА: неизвестный аргумент: $arg" >&2; exit 1 ;;
	esac
done

die() {
	echo "ОШИБКА: $*" >&2
	exit 1
}

warn() {
	echo "ВНИМАНИЕ: $*" >&2
}

read_env() {
	[[ -f "$1" ]] || return 0
	sed -n "s|^$2=||p" "$1" | tail -1
}

set_env() {
	local file="$1" key="$2" value="$3"
	if grep -q "^$key=" "$file"; then
		sed -i "s|^$key=.*|$key=$value|" "$file"
	else
		printf '%s=%s\n' "$key" "$value" >> "$file"
	fi
}

wait_mc() {
	local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
	until curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:7777/system/info; do
		(( SECONDS < deadline )) || return 1
		sleep 3
	done
}

# ========== Проверки ==========

[[ "$(id -u)" == "0" ]] || die "нужны права root, запускайте через sudo"

command -v docker >/dev/null || die "не найден docker"
docker compose version >/dev/null 2>&1 || die "не найден плагин docker compose"
docker info >/dev/null 2>&1 || die "демон docker недоступен"

[[ -f .env ]] || die "рядом нет .env — запускайте скрипт из каталога развёртывания"
[[ -f docker-compose.yml ]] || die "рядом нет docker-compose.yml"

CURRENT_TAG="$(read_env .env TAG)"
PREV_TAG="$(read_env .env PREV_TAG)"

export COMPOSE_PROJECT_NAME="$(read_env .env COMPOSE_PROJECT_NAME)"
[[ -n "$COMPOSE_PROJECT_NAME" ]] || die "в .env нет COMPOSE_PROJECT_NAME"

# Ядро есть только у роли исполнителя, и только если оно ставилось пакетом
MC=0
if [[ "$COMPOSE_PROJECT_NAME" == "varan-minion" && -d debs ]]; then
	MC=1
fi

if [[ -n "$TO" && "$TO" == "$CURRENT_TAG" ]]; then
	SWAP=0
	TARGET_TAG="$CURRENT_TAG"
	echo "==> Версия $CURRENT_TAG уже выбрана, поднимаются её сервисы"
else
	SWAP=1
	TARGET_TAG="$PREV_TAG"
	[[ -n "$TARGET_TAG" ]] || die "предыдущей версии нет, откатываться некуда"
	[[ "$TARGET_TAG" != "$CURRENT_TAG" ]] || die "предыдущая версия совпадает с текущей: $CURRENT_TAG"
	[[ -z "$TO" || "$TO" == "$TARGET_TAG" ]] || die "версии $TO на устройстве нет: текущая $CURRENT_TAG, предыдущая ${PREV_TAG:-нет}"

	# Образы предыдущей версии должны лежать на устройстве: сети тут нет.
	MISSING=()
	while read -r img; do
		base="${img%:*}"
		if ! docker image inspect "$base:$TARGET_TAG" >/dev/null 2>&1; then
			MISSING+=("$base:$TARGET_TAG")
		fi
	done < <(TAG="$CURRENT_TAG" docker compose config --images)

	if [[ ${#MISSING[@]} -gt 0 ]]; then
		die "нет образов предыдущей версии: ${MISSING[*]}"
	fi

	echo "==> Откат $CURRENT_TAG -> $TARGET_TAG"
fi

MC_DEB="debs/media-center_$TARGET_TAG.deb"
if [[ "$MC" == "1" && ! -f "$MC_DEB" ]]; then
	warn "нет $MC_DEB — ядро остаётся на установленной версии"
fi

# ========== Переключение ==========

if [[ "$SWAP" == "1" ]]; then
	# Ядро останавливается первым: оно пишет через storage-service и шлёт в сигналинг.
	if [[ "$MC" == "1" ]] && systemctl is-active --quiet media-center.service; then
		systemctl stop media-center.service
	fi

	docker compose down

	# Описание сервисов откатывается вместе с образами, иначе старые образы
	# поднимутся по новому compose.
	if [[ -f docker-compose.prev.yml ]]; then
		mv docker-compose.yml docker-compose.swap.yml
		mv docker-compose.prev.yml docker-compose.yml
		mv docker-compose.swap.yml docker-compose.prev.yml
	else
		warn "нет docker-compose.prev.yml — откатываются только образы, описание сервисов остаётся текущим"
	fi

	set_env .env TAG "$TARGET_TAG"
	set_env .env PREV_TAG "$CURRENT_TAG"
fi

docker compose up -d

# ========== Ожидание готовности ==========

echo "==> Ожидание готовности сервисов (до ${HEALTH_TIMEOUT}с)"
DEADLINE=$(( SECONDS + HEALTH_TIMEOUT ))
HEALTHY=1
while :; do
	PENDING=()
	for cid in $(docker compose ps -q); do
		name="$(docker inspect -f '{{.Name}}' "$cid" | sed 's|^/||')"
		state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
		case "$state" in
			healthy|running) ;;
			*) PENDING+=("$name=$state") ;;
		esac
	done

	if [[ ${#PENDING[@]} -eq 0 ]]; then
		break
	fi

	if (( SECONDS >= DEADLINE )); then
		warn "не дождались готовности: ${PENDING[*]}"
		HEALTHY=0
		break
	fi

	sleep 3
done

# ========== Ядро ==========

MC_OK=1
if [[ "$MC" == "1" ]]; then
	if [[ -f "$MC_DEB" && "$(dpkg-deb -f "$MC_DEB" Version)" != "$(dpkg-query -W -f='${Version}' media-center 2>/dev/null || true)" ]]; then
		echo "==> Ядро $(dpkg-deb -f "$MC_DEB" Version)"
		systemctl stop media-center.service || true
		dpkg -i "$MC_DEB"
	fi
	systemctl start media-center.service
	if ! wait_mc; then
		warn "media-center не ответил на /system/info за ${HEALTH_TIMEOUT}с, смотрите journalctl -u media-center"
		MC_OK=0
	fi
fi

echo
docker compose ps
echo
echo "Версия:     $TARGET_TAG"
echo "Предыдущая: $(read_env .env PREV_TAG)"
if [[ "$MC" == "1" ]]; then
	echo "Ядро:       $(dpkg-query -W -f='${Version}' media-center 2>/dev/null)"
fi

if [[ "$HEALTHY" == "0" ]]; then
	echo
	die "часть сервисов не поднялась, смотрите docker compose logs"
fi

if [[ "$MC_OK" == "0" ]]; then
	echo
	die "media-center не поднялся"
fi

echo
echo "Откат завершён."
