#!/usr/bin/env bash
# Откат на предыдущую версию: меняет местами TAG и PREV_TAG и перезапускает
# сервисы уже загруженными образами. Сеть и пакет на устройстве не нужны.
#
#   sudo /opt/varan-<роль>/rollback.sh
#
# Повторный запуск возвращает обратно: скрипт переключает две версии между собой.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

HEALTH_TIMEOUT=180

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

# ========== Проверки ==========

[[ "$(id -u)" == "0" ]] || die "нужны права root, запускайте через sudo"

command -v docker >/dev/null || die "не найден docker"
docker compose version >/dev/null 2>&1 || die "не найден плагин docker compose"
docker info >/dev/null 2>&1 || die "демон docker недоступен"

[[ -f .env ]] || die "рядом нет .env — запускайте скрипт из каталога развёртывания"
[[ -f docker-compose.yml ]] || die "рядом нет docker-compose.yml"

CURRENT_TAG="$(read_env .env TAG)"
TARGET_TAG="$(read_env .env PREV_TAG)"

[[ -n "$TARGET_TAG" ]] || die "предыдущей версии нет, откатываться некуда"
[[ "$TARGET_TAG" != "$CURRENT_TAG" ]] || die "предыдущая версия совпадает с текущей: $CURRENT_TAG"

export COMPOSE_PROJECT_NAME="$(read_env .env COMPOSE_PROJECT_NAME)"
[[ -n "$COMPOSE_PROJECT_NAME" ]] || die "в .env нет COMPOSE_PROJECT_NAME"

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

# ========== Переключение ==========

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

echo
docker compose ps
echo
echo "Версия:     $TARGET_TAG"
echo "Предыдущая: $CURRENT_TAG"

if [[ "$HEALTHY" == "0" ]]; then
	echo
	die "часть сервисов не поднялась, смотрите docker compose logs"
fi

echo
echo "Откат завершён."
