#!/usr/bin/env bash
# Сборка оффлайн-пакета роли: образы, compose, окружение, установщики.
# Запускается на arm64-устройстве с интернетом, где склонирован репозиторий.
#
#   scripts/build-package.sh --role=master --full-auth
#   scripts/build-package.sh --role=minion --out-dir=/home/orangepi/packages
#
# Результат: varan-<роль>-<дата>-<sha>[-dirty][-auth].tar.gz

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ROLE=""
FULL_AUTH="false"
OUT_DIR="$PWD"

usage() {
	cat <<'EOF'
Использование: build-package.sh --role=master|minion [--full-auth] [--out-dir=DIR]

  --role=ROLE     master или minion
  --full-auth     фронт собирается с авторизацией на всех маршрутах (только master)
  --out-dir=DIR   куда положить архив (по умолчанию текущий каталог)
EOF
}

die() {
	echo "ОШИБКА: $*" >&2
	exit 1
}

warn() {
	echo "ВНИМАНИЕ: $*" >&2
}

for arg in "$@"; do
	case "$arg" in
		--role=*) ROLE="${arg#*=}" ;;
		--full-auth) FULL_AUTH="true" ;;
		--out-dir=*) OUT_DIR="${arg#*=}" ;;
		-h|--help) usage; exit 0 ;;
		*) usage >&2; die "неизвестный аргумент: $arg" ;;
	esac
done

# ========== Проверки окружения ==========

case "$ROLE" in
	master|minion) ;;
	"") usage >&2; die "не задан --role" ;;
	*) die "неизвестная роль: $ROLE (ожидается master или minion)" ;;
esac

if [[ "$ROLE" == "minion" && "$FULL_AUTH" == "true" ]]; then
	die "--full-auth относится только к фронту, а он в наборе master"
fi

ARCH="$(uname -m)"
[[ "$ARCH" == "aarch64" ]] || die "образы собираются только на aarch64, здесь $ARCH"

command -v git >/dev/null || die "не найден git"
command -v docker >/dev/null || die "не найден docker"
docker compose version >/dev/null 2>&1 || die "не найден плагин docker compose"
docker info >/dev/null 2>&1 || die "демон docker недоступен"

COMPOSE_FILE="$REPO_ROOT/docker-compose.$ROLE.yml"
[[ -f "$COMPOSE_FILE" ]] || die "не найден $COMPOSE_FILE"

# ========== Тег версии ==========

cd "$REPO_ROOT"

SHA="$(git rev-parse --short HEAD)"
TAG="$(date +%Y-%m-%d)-$SHA"

# Незакоммиченные правки делают sha неточным, помечаем тег.
if ! git diff --quiet HEAD -- || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
	TAG="$TAG-dirty"
	warn "в рабочем дереве есть незакоммиченные изменения, тег помечен -dirty"
fi

SUFFIX=""
[[ "$FULL_AUTH" == "true" ]] && SUFFIX="-auth"

PKG_NAME="varan-$ROLE-$TAG$SUFFIX"

export TAG FULL_AUTH

echo "==> Роль: $ROLE, тег: $TAG, FULL_AUTH=$FULL_AUTH"

# ========== Сборка образов ==========

echo "==> Сборка образов"
docker compose -f "$COMPOSE_FILE" build

mapfile -t IMAGES < <(docker compose -f "$COMPOSE_FILE" config --images)
[[ ${#IMAGES[@]} -gt 0 ]] || die "в $COMPOSE_FILE не найдено ни одного сервиса"

# Имя образа без префикса varan/ означает, что у сервиса нет image: и compose
# вывел имя из имени каталога проекта — на устройстве такой образ не найдётся.
for img in "${IMAGES[@]}"; do
	[[ "$img" == varan/* ]] || die "образ '$img': в $COMPOSE_FILE у каждого сервиса должен быть image: varan/<сервис>:\${TAG:-latest}"
	[[ "$img" == *":$TAG" ]] || die "образ '$img' собран не с тегом $TAG"
done

echo "==> Образы пакета:"
printf '    %s\n' "${IMAGES[@]}"

# ========== Наполнение пакета ==========

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$PKG_NAME"
mkdir -p "$STAGE"

echo "==> docker save"
docker save "${IMAGES[@]}" -o "$STAGE/images.tar"

# На устройстве файл лежит под именем по умолчанию, чтобы docker compose
# находил его без -f.
cp "$COMPOSE_FILE" "$STAGE/docker-compose.yml"

# Окружение. Мастеру нужен корень varan, миньону — только тег: storage-service
# смотрит в фиксированный /storage, а --varan-root получает media-center на хосте.
if [[ "$ROLE" == "master" ]]; then
	[[ -f "$REPO_ROOT/.env.example" ]] || die "не найден $REPO_ROOT/.env.example"
	grep -v -E '^(TAG|FULL_AUTH)=' "$REPO_ROOT/.env.example" > "$STAGE/.env.example"
else
	: > "$STAGE/.env.example"
fi

cat >> "$STAGE/.env.example" <<EOF

# Зафиксировано при сборке пакета, править вручную не нужно.
TAG=$TAG
EOF

if [[ "$ROLE" == "master" ]]; then
	echo "FULL_AUTH=$FULL_AUTH" >> "$STAGE/.env.example"
fi

# Установщики едут из репозитория, если они там уже есть.
for script in install.sh rollback.sh; do
	src="$REPO_ROOT/scripts/package/$script"
	if [[ -f "$src" ]]; then
		cp "$src" "$STAGE/$script"
		chmod +x "$STAGE/$script"
	else
		warn "не найден $src — в пакет не попал"
	fi
done

# ========== Архив ==========

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
ARCHIVE="$OUT_DIR/$PKG_NAME.tar.gz"

echo "==> Упаковка"
tar -czf "$ARCHIVE" -C "$WORK" "$PKG_NAME"

echo "==> Готово: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
