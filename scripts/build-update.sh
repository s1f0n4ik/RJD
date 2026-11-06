#!/usr/bin/env bash
# Сборка файла обновления varan: образы обеих ролей, ядро и служба обновления в одном .tar.
# Запускается на arm64-плате с интернетом, где склонирован репозиторий.
#
#   scripts/build-update.sh                          полный файл: первая установка и отставшие платы
#   scripts/build-update.sh --base=<тег>             дельта от установленного выпуска
#   scripts/build-update.sh --full-auth --out-dir=/home/orangepi/updates
#
# Результат: varan-update-<тег>-full.tar или varan-update-<тег>-from-<база>.tar;
# манифест выпуска остаётся в $VARAN_RELEASES_DIR/<тег>/ для следующих дельт.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE=""
FULL_AUTH="false"
OUT_DIR="$PWD"
ALLOW_DIRTY="false"
RELEASES_DIR="${VARAN_RELEASES_DIR:-$HOME/varan-releases}"
BUILD_ROOT="${VARAN_BUILD_DIR:-$HOME/varan-build}"
# Ядро собирается в четыре потока: на восьми плата перезагружалась вместе с работающим media-center
MC_JOBS="${MC_BUILD_JOBS:-4}"
DELTA_WARN=$(( 200 * 1024 * 1024 ))

usage() {
	cat <<'EOF'
Использование: build-update.sh [--base=TAG] [--full-auth] [--out-dir=DIR] [--allow-dirty]

  --base=TAG      дельта от выпуска TAG (его манифест в $VARAN_RELEASES_DIR/TAG/)
  --full-auth     фронт собирается с авторизацией на всех маршрутах
  --out-dir=DIR   куда положить файл (по умолчанию текущий каталог)
  --allow-dirty   собрать из незакоммиченного дерева, тег помечается -dirty
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
		--base=*) BASE="${arg#*=}" ;;
		--full-auth) FULL_AUTH="true" ;;
		--out-dir=*) OUT_DIR="${arg#*=}" ;;
		--allow-dirty) ALLOW_DIRTY="true" ;;
		-h|--help) usage; exit 0 ;;
		*) usage >&2; die "неизвестный аргумент: $arg" ;;
	esac
done

# ========== Проверки окружения ==========

ARCH="$(uname -m)"
[[ "$ARCH" == "aarch64" ]] || die "образы и ядро собираются только на aarch64, здесь $ARCH"

for tool in git docker cmake dpkg-deb python3; do
	command -v "$tool" >/dev/null || die "не найден $tool"
done
docker compose version >/dev/null 2>&1 || die "не найден плагин docker compose"
docker info >/dev/null 2>&1 || die "демон docker недоступен"
[[ -f /opt/gstreamer-1.28/env.sh ]] || die "нет /opt/gstreamer-1.28/env.sh: ядро не соберётся"

# ========== Тег выпуска ==========

cd "$REPO_ROOT"

SHA="$(git rev-parse --short=7 HEAD)"
STAMP="$(date +%Y-%m-%d-%H%M)"
TAG="$STAMP-$SHA"
DEB_SUFFIX="${STAMP//-/}.$SHA"

# Выпуск определяется коммитом: из грязного дерева он не воспроизводится
if ! git diff --quiet HEAD -- || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
	[[ "$ALLOW_DIRTY" == "true" ]] || die "в рабочем дереве есть незакоммиченные изменения; закоммитьте их или запустите с --allow-dirty"
	TAG="$TAG-dirty"
	DEB_SUFFIX="$DEB_SUFFIX.dirty"
	warn "сборка из незакоммиченного дерева, тег помечен -dirty"
fi

BASE_MANIFEST=""
if [[ -n "$BASE" ]]; then
	BASE_MANIFEST="$RELEASES_DIR/$BASE/manifest.json"
	[[ -f "$BASE_MANIFEST" ]] || die "нет манифеста базы $BASE_MANIFEST: дельта собирается только от выпуска, собранного этим скриптом"
fi
[[ ! -e "$RELEASES_DIR/$TAG" ]] || die "выпуск $TAG уже собран: $RELEASES_DIR/$TAG"

SUFFIX=""
[[ "$FULL_AUTH" == "true" ]] && SUFFIX="-auth"
if [[ -n "$BASE" ]]; then
	NAME="varan-update-$TAG-from-$BASE$SUFFIX.tar"
else
	NAME="varan-update-$TAG-full$SUFFIX.tar"
fi

export TAG FULL_AUTH

echo "==> Выпуск $TAG, база: ${BASE:-нет (полный файл)}, FULL_AUTH=$FULL_AUTH"

# Рабочий каталог на диске: в /tmp (tmpfs) полные образы не помещаются
WORK="$BUILD_ROOT/work-$TAG"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"

# ========== Образы ролей ==========

for ROLE in minion master; do
	COMPOSE_FILE="$REPO_ROOT/docker-compose.$ROLE.yml"
	[[ -f "$COMPOSE_FILE" ]] || die "не найден $COMPOSE_FILE"
	FILES=(-f "$COMPOSE_FILE")

	# Кэш из образов базы: неизменные шаги дают те же слои, даже если кэш сборки чистили
	if [[ -n "$BASE" ]]; then
		OVERRIDE="$WORK/cache-from-$ROLE.yml"
		echo "services:" > "$OVERRIDE"
		for svc in $(docker compose -f "$COMPOSE_FILE" config --services); do
			if docker image inspect "varan/$svc:$BASE" >/dev/null 2>&1; then
				printf '  %s:\n    build:\n      cache_from:\n        - varan/%s:%s\n' "$svc" "$svc" "$BASE" >> "$OVERRIDE"
			else
				warn "нет образа varan/$svc:$BASE — его слои в дельте будут собраны заново"
			fi
		done
		FILES+=(-f "$OVERRIDE")
	fi

	echo "==> Сборка образов роли $ROLE"
	docker compose "${FILES[@]}" build --build-arg BUILDKIT_INLINE_CACHE=1

	mapfile -t IMAGES < <(docker compose -f "$COMPOSE_FILE" config --images)
	[[ ${#IMAGES[@]} -gt 0 ]] || die "в $COMPOSE_FILE не найдено ни одного сервиса"
	for img in "${IMAGES[@]}"; do
		[[ "$img" == varan/* ]] || die "образ '$img': в $COMPOSE_FILE у каждого сервиса должен быть image: varan/<сервис>:\${TAG:-latest}"
		[[ "$img" == *":$TAG" ]] || die "образ '$img' собран не с тегом $TAG"
	done

	mkdir -p "$STAGE/$ROLE"
	echo "==> docker save роли $ROLE"
	docker save "${IMAGES[@]}" -o "$STAGE/$ROLE/images.tar"

	# На устройстве файл лежит под именем по умолчанию, чтобы docker compose находил его без -f
	cp "$COMPOSE_FILE" "$STAGE/$ROLE/docker-compose.yml"

	# Мастеру нужен корень varan, миньону — только тег: storage-service смотрит в фиксированный /storage
	if [[ "$ROLE" == "master" ]]; then
		[[ -f "$REPO_ROOT/.env.example" ]] || die "не найден $REPO_ROOT/.env.example"
		grep -v -E '^(TAG|FULL_AUTH)=' "$REPO_ROOT/.env.example" > "$STAGE/$ROLE/.env.example"
	else
		: > "$STAGE/$ROLE/.env.example"
	fi
	printf '\n# Зафиксировано при сборке, править вручную не нужно.\nTAG=%s\n' "$TAG" >> "$STAGE/$ROLE/.env.example"
	if [[ "$ROLE" == "master" ]]; then
		echo "FULL_AUTH=$FULL_AUTH" >> "$STAGE/$ROLE/.env.example"
	fi

	for script in install.sh rollback.sh; do
		install -m 755 "$REPO_ROOT/scripts/package/$script" "$STAGE/$ROLE/$script"
	done
done

# ========== Ядро ==========

MC_BUILD_DIR="$BUILD_ROOT/media-center"
MC_VERSION="$(sed -n 's/^project(media-center VERSION \([0-9.]*\).*/\1/p' "$REPO_ROOT/media-center/CMakeLists.txt")"
[[ -n "$MC_VERSION" ]] || die "не нашёл версию в media-center/CMakeLists.txt"
MC_VERSION="$MC_VERSION+$DEB_SUFFIX"

echo "==> Сборка ядра Release в $MC_BUILD_DIR (-j$MC_JOBS)"
(
	set +u
	source /opt/gstreamer-1.28/env.sh
	cmake -S "$REPO_ROOT/media-center" -B "$MC_BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
	nice cmake --build "$MC_BUILD_DIR" -j"$MC_JOBS"
)

mkdir -p "$WORK/debs"
MC_DEB="$(bash "$REPO_ROOT/media-center/build-deb.sh" "$MC_BUILD_DIR" "$MC_VERSION" "$WORK/debs")"
mv "$MC_DEB" "$STAGE/media-center.deb"

UPDATER_VERSION="1.0.0+$DEB_SUFFIX"
UPDATER_DEB="$(bash "$REPO_ROOT/updater/build-deb.sh" "$UPDATER_VERSION" "$WORK/debs")"
mv "$UPDATER_DEB" "$STAGE/updater.deb"

# ========== Файл обновления ==========

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
ARCHIVE="$OUT_DIR/$NAME"

echo "==> Упаковка"
python3 "$REPO_ROOT/scripts/update-pack.py" --stage "$STAGE" --tag "$TAG" --base-manifest "$BASE_MANIFEST" \
	--mc-dir "$MC_BUILD_DIR" --updater-dir "$REPO_ROOT/updater" --updater-version "$UPDATER_VERSION" --out "$ARCHIVE"

mkdir -p "$RELEASES_DIR/$TAG"
cp "$STAGE/manifest.json" "$RELEASES_DIR/$TAG/manifest.json"

SIZE="$(stat -c %s "$ARCHIVE")"
if [[ -n "$BASE" ]] && (( SIZE > DELTA_WARN )); then
	warn "дельта больше 200 МБ: изменились зависимости или базовый образ"
fi

echo "==> Готово: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "    манифест выпуска: $RELEASES_DIR/$TAG/manifest.json"
echo "    образы varan/*:$TAG остаются здесь: от них собираются следующие дельты"
