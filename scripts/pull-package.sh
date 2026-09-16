#!/usr/bin/env bash
# Выгрузка уже собранных образов с платы в оффлайн-пакеты обеих ролей.
# Запускается на машине разработчика; на плате ничего не собирается —
# берутся текущие varan/*:latest. Сборка с нуля — scripts/build-package.sh.
#
#   scripts/pull-package.sh
#   scripts/pull-package.sh --host=orangepi@192.168.1.4 --out-dir=/tmp/pkg
#
# Результат: <out-dir>/varan-master-<тег>/ и <out-dir>/varan-minion-<тег>/,
# каждый ставится на офлайн-машине через sudo ./install.sh (внутри docker load).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

HOST="orangepi@192.168.1.102"
OUT_DIR="$REPO_ROOT/dist"

usage() {
	cat <<'EOF'
Использование: pull-package.sh [--host=USER@HOST] [--out-dir=DIR]

  --host=USER@HOST   плата-источник (по умолчанию orangepi@192.168.1.102)
  --out-dir=DIR      куда положить каталоги пакетов (по умолчанию <репозиторий>/dist)
EOF
}

die() {
	echo "ОШИБКА: $*" >&2
	exit 1
}

for arg in "$@"; do
	case "$arg" in
		--host=*) HOST="${arg#*=}" ;;
		--out-dir=*) OUT_DIR="${arg#*=}" ;;
		-h|--help) usage; exit 0 ;;
		*) usage >&2; die "неизвестный аргумент: $arg" ;;
	esac
done

command -v ssh >/dev/null || die "не найден ssh"

# ========== Тег версии: состояние репозитория на плате ==========

# Образы собраны там, поэтому версия берётся из тамошнего HEAD, а не локального.
REMOTE_REPO="$(ssh "$HOST" 'ls -d ~/RJD /opt/RJD 2>/dev/null | head -1')"
[[ -n "$REMOTE_REPO" ]] || die "на $HOST не найден клон репозитория (~/RJD или /opt/RJD)"

TAG="$(ssh "$HOST" "cd $REMOTE_REPO && printf '%s-%s' \"\$(date +%Y-%m-%d)\" \"\$(git rev-parse --short HEAD)\"")"
DIRTY="$(ssh "$HOST" "cd $REMOTE_REPO && git status --porcelain | head -1")"
[[ -z "$DIRTY" ]] || { TAG="$TAG-dirty"; echo "ВНИМАНИЕ: на плате незакоммиченные изменения, тег помечен -dirty" >&2; }

echo "==> Источник: $HOST ($REMOTE_REPO), тег: $TAG"

# ========== Пакеты по ролям ==========

for ROLE in master minion; do
	COMPOSE_FILE="$REPO_ROOT/docker-compose.$ROLE.yml"
	[[ -f "$COMPOSE_FILE" ]] || die "не найден $COMPOSE_FILE"

	# Состав роли читается из compose, чтобы список сервисов не дублировался здесь.
	mapfile -t SERVICES < <(sed -n 's|.*image: varan/\([a-z0-9-]*\):.*|\1|p' "$COMPOSE_FILE")
	[[ ${#SERVICES[@]} -gt 0 ]] || die "в $COMPOSE_FILE нет ни одного образа varan/*"

	STAGE="$OUT_DIR/varan-$ROLE-$TAG"
	mkdir -p "$STAGE"

	echo "==> $ROLE: ${SERVICES[*]}"

	# Образ едет с двумя именами: :latest поднимается без .env, :<тег> нужен
	# install.sh и rollback.sh, которые переключают версии по TAG.
	REFS=""
	for svc in "${SERVICES[@]}"; do
		REFS="$REFS varan/$svc:latest varan/$svc:$TAG"
	done

	TAG_CMD=""
	for svc in "${SERVICES[@]}"; do
		TAG_CMD="$TAG_CMD docker image inspect varan/$svc:latest >/dev/null || exit 1;"
		TAG_CMD="$TAG_CMD docker tag varan/$svc:latest varan/$svc:$TAG;"
	done

	echo "    docker save -> $STAGE/images.tar"
	ssh "$HOST" "set -e; $TAG_CMD docker save$REFS" > "$STAGE/images.tar" \
		|| die "$ROLE: не удалось выгрузить образы (проверьте, что все varan/*:latest есть на плате)"

	# На офлайн-машине файл должен лежать под именем по умолчанию, чтобы
	# docker compose находил его без -f.
	cp "$COMPOSE_FILE" "$STAGE/docker-compose.yml"

	# Мастеру нужен корень varan, миньону — только тег: storage-service смотрит
	# в фиксированный /storage, а --varan-root получает media-center на хосте.
	if [[ "$ROLE" == "master" ]]; then
		grep -v -E '^(TAG|FULL_AUTH)=' "$REPO_ROOT/.env.example" > "$STAGE/.env.example"
	else
		: > "$STAGE/.env.example"
	fi

	cat >> "$STAGE/.env.example" <<EOF

# Зафиксировано при выгрузке пакета, править вручную не нужно.
TAG=$TAG
EOF

	# FULL_AUTH запечён во фронт на сборке, здесь он уже не выбирается.
	[[ "$ROLE" == "master" ]] && echo "FULL_AUTH=false" >> "$STAGE/.env.example"

	for script in install.sh rollback.sh; do
		cp "$REPO_ROOT/scripts/package/$script" "$STAGE/$script"
		chmod +x "$STAGE/$script"
	done

	echo "    готово: $STAGE ($(du -sh "$STAGE" | cut -f1))"
done

cat <<EOF

Перенести каталоги на офлайн-машину и поставить:
  sudo ./install.sh                 # docker load + compose up
Только загрузка образов:
  docker load -i images.tar
EOF
