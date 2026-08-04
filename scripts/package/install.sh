#!/usr/bin/env bash
# Установка оффлайн-пакета varan на устройстве. Запускается из распакованного
# каталога пакета, от root:
#
#   sudo ./install.sh
#
# Состояние развёртывания (compose, .env, rollback.sh) живёт в /opt/varan-<роль>
# и переживает смену версий: каталог пакета одноразовый.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Сколько ждём, пока все сервисы станут healthy.
HEALTH_TIMEOUT=180

die() {
	echo "ОШИБКА: $*" >&2
	exit 1
}

warn() {
	echo "ВНИМАНИЕ: $*" >&2
}

read_env() {
	# read_env <файл> <ключ>
	[[ -f "$1" ]] || return 0
	sed -n "s|^$2=||p" "$1" | tail -1
}

set_env() {
	# set_env <файл> <ключ> <значение>
	local file="$1" key="$2" value="$3"
	if grep -q "^$key=" "$file"; then
		sed -i "s|^$key=.*|$key=$value|" "$file"
	else
		printf '%s=%s\n' "$key" "$value" >> "$file"
	fi
}

# ========== Проверки окружения ==========

[[ "$(id -u)" == "0" ]] || die "нужны права root, запускайте через sudo"

ARCH="$(uname -m)"
[[ "$ARCH" == "aarch64" ]] || die "пакет собран под aarch64, здесь $ARCH"

command -v docker >/dev/null || die "не найден docker"
docker compose version >/dev/null 2>&1 || die "не найден плагин docker compose"
docker info >/dev/null 2>&1 || die "демон docker недоступен"

for f in images.tar docker-compose.yml .env.example; do
	[[ -f "$f" ]] || die "в каталоге пакета нет $f"
done

# ========== Роль и каталог развёртывания ==========

# VARAN_ROOT встречается только в compose мастера — по нему и различаем роли.
if grep -q 'VARAN_ROOT' docker-compose.yml; then
	ROLE="master"
else
	ROLE="minion"
fi

INSTALL_DIR="/opt/varan-$ROLE"
export COMPOSE_PROJECT_NAME="varan-$ROLE"

PKG_TAG="$(read_env .env.example TAG)"
[[ -n "$PKG_TAG" ]] || die "в .env.example пакета нет TAG"

OLD_TAG="$(read_env "$INSTALL_DIR/.env" TAG)"
OLD_PREV_TAG="$(read_env "$INSTALL_DIR/.env" PREV_TAG)"
OLD_ROOT="$(read_env "$INSTALL_DIR/.env" VARAN_ROOT)"

echo "==> Роль: $ROLE, версия пакета: $PKG_TAG"
if [[ -n "$OLD_TAG" ]]; then
	echo "==> Установлено сейчас: $OLD_TAG"
else
	echo "==> Установки на этом устройстве ещё не было"
fi

# ========== Рабочий каталог varan (только мастер) ==========

VARAN_ROOT=""
if [[ "$ROLE" == "master" ]]; then
	if [[ -n "$OLD_ROOT" ]]; then
		DEFAULT_ROOT="$OLD_ROOT"
	elif [[ -d /home/orangepi/varan ]]; then
		DEFAULT_ROOT="/home/orangepi/varan"
	else
		DEFAULT_ROOT="/var/lib/varan"
	fi

	[[ -t 0 ]] || die "нужен интерактивный терминал: скрипт спрашивает корень varan (ssh -t)"

	echo
	echo "Корень рабочего каталога varan. В нём лежит settings/devices.json —"
	echo "реестр устройств мастера. Enter оставит значение по умолчанию."
	read -r -p "VARAN_ROOT [$DEFAULT_ROOT]: " VARAN_ROOT
	VARAN_ROOT="${VARAN_ROOT:-$DEFAULT_ROOT}"
	[[ "$VARAN_ROOT" == /* ]] || die "путь должен быть абсолютным: $VARAN_ROOT"
	echo

	if [[ -n "$OLD_ROOT" && "$VARAN_ROOT" != "$OLD_ROOT" ]]; then
		warn "корень меняется с $OLD_ROOT на $VARAN_ROOT — реестр устройств по новому пути будет пустым"
	fi

	# Каталог создаётся заранее: bind-mount иначе сделает его от root с неверными правами.
	mkdir -p "$VARAN_ROOT/settings"
fi

# ========== Перенос старого стека ==========

# Контейнеры со старыми именами живут вне нашего проекта, но держат те же имена
# и те же порты хоста, поэтому up -d на них упадёт. Перед удалением снимается
# копия: образы, содержимое томов и описание контейнеров.
mapfile -t SERVICE_NAMES < <(sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' docker-compose.yml)

LEGACY=()
for name in "${SERVICE_NAMES[@]}"; do
	cid="$(docker ps -aq --filter "name=^/${name}$")"
	if [[ -z "$cid" ]]; then
		continue
	fi
	project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid")"
	if [[ "$project" == "$COMPOSE_PROJECT_NAME" ]]; then
		continue
	fi
	LEGACY+=("$cid")
	echo "    посторонний контейнер: $name (проект: ${project:-без проекта})"
done

if [[ ${#LEGACY[@]} -gt 0 ]]; then
	echo "==> Найден старый стек: ${#LEGACY[@]} шт."

	BACKUP_STAMP="$(date +%Y-%m-%d-%H%M%S)"
	BACKUP_DIR="${VARAN_BACKUP_DIR:-/opt/varan-backup}/$BACKUP_STAMP"

	# Имя образа из контейнера может уже никуда не указывать: пересборка с тем же
	# тегом оставляет старый образ безымянным, а контейнер работает с него по id.
	mapfile -t LEGACY_IMAGE_IDS < <(docker inspect -f '{{.Image}}' "${LEGACY[@]}" | sort -u)
	mapfile -t LEGACY_VOLUMES < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "${LEGACY[@]}" | sed '/^$/d' | sort -u)

	# Место под копию считается заранее: старые образы шлюза тянут на гигабайты.
	NEED=0
	for iid in "${LEGACY_IMAGE_IDS[@]}"; do
		NEED=$(( NEED + $(docker image inspect -f '{{.Size}}' "$iid" 2>/dev/null || echo 0) ))
	done
	for vol in ${LEGACY_VOLUMES[@]+"${LEGACY_VOLUMES[@]}"}; do
		mnt="$(docker volume inspect -f '{{.Mountpoint}}' "$vol")"
		NEED=$(( NEED + $(du -sb "$mnt" | cut -f1) ))
	done

	mkdir -p "$BACKUP_DIR"
	AVAIL="$(df -B1 --output=avail "$BACKUP_DIR" | tail -1)"
	if (( AVAIL < NEED * 12 / 10 )); then
		rmdir "$BACKUP_DIR" 2>/dev/null || true
		die "под копию старого стека нужно ~$(( NEED / 1024 / 1024 )) МБ, свободно $(( AVAIL / 1024 / 1024 )) МБ; освободите место или укажите другой раздел через VARAN_BACKUP_DIR"
	fi

	# Собственный тег на время копии: без имени образ после docker load
	# восстановится как <none> и понять, чей он, будет нечем.
	LEGACY_IMAGES=()
	for cid in "${LEGACY[@]}"; do
		cname="$(docker inspect -f '{{.Name}}' "$cid" | sed 's|^/||')"
		ref="varan-backup/$cname:$BACKUP_STAMP"
		docker tag "$(docker inspect -f '{{.Image}}' "$cid")" "$ref"
		LEGACY_IMAGES+=("$ref")
	done

	echo "==> Копия старого стека: $BACKUP_DIR"
	docker inspect "${LEGACY[@]}" > "$BACKUP_DIR/containers.json"
	docker save "${LEGACY_IMAGES[@]}" -o "$BACKUP_DIR/images.tar"

	for vol in ${LEGACY_VOLUMES[@]+"${LEGACY_VOLUMES[@]}"}; do
		mnt="$(docker volume inspect -f '{{.Mountpoint}}' "$vol")"
		tar -czf "$BACKUP_DIR/volume-$vol.tar.gz" -C "$mnt" .
		echo "    том $vol сохранён"
	done

	cat > "$BACKUP_DIR/README.txt" <<EOF
Копия стека, снятая перед установкой пакета $PKG_TAG.

images.tar          образы старых контейнеров, восстанавливаются docker load -i images.tar
containers.json     docker inspect старых контейнеров: команды, тома, переменные, порты
volume-*.tar.gz     содержимое именованных томов, распаковывается в точку монтирования тома

Контейнеры автоматически не восстанавливаются: параметры запуска берутся
из containers.json. Тома старого проекта не удалялись и лежат на месте.
EOF

	echo "==> Остановка и удаление старых контейнеров"
	docker rm -f "${LEGACY[@]}" >/dev/null

	# Имя тома включает имя проекта, поэтому новый проект получил бы пустые тома.
	for vol in ${LEGACY_VOLUMES[@]+"${LEGACY_VOLUMES[@]}"}; do
		target="${COMPOSE_PROJECT_NAME}_${vol#*_}"
		if docker volume inspect "$target" >/dev/null 2>&1; then
			echo "    том $target уже существует, перенос $vol пропущен"
			continue
		fi
		docker volume create "$target" >/dev/null
		cp -a "$(docker volume inspect -f '{{.Mountpoint}}' "$vol")/." \
			"$(docker volume inspect -f '{{.Mountpoint}}' "$target")/"
		echo "    том перенесён: $vol -> $target"
	done

	# Старые образы остаются на диске вдобавок к копии, но удалять их за
	# оператора нельзя: имена не наши, ими может пользоваться что-то ещё.
	echo "    старые образы сохранены в копии и всё ещё занимают диск, удалить:"
	echo "        docker image rm ${LEGACY_IMAGES[*]}"
fi

# ========== Остановка текущей версии ==========

if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
	echo "==> Остановка текущей версии"
	docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" down
fi

# ========== Загрузка образов ==========

echo "==> Загрузка образов"
docker load -i images.tar

# ========== Раскладка файлов ==========

mkdir -p "$INSTALL_DIR"

# Compose предыдущей версии остаётся рядом: без него откат поднимет старые
# образы по новому описанию сервисов.
if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
	cp "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.prev.yml"
fi

cp docker-compose.yml "$INSTALL_DIR/docker-compose.yml"

if [[ -f rollback.sh ]]; then
	cp rollback.sh "$INSTALL_DIR/rollback.sh"
	chmod +x "$INSTALL_DIR/rollback.sh"
else
	warn "в пакете нет rollback.sh — откат будет недоступен"
fi

# Существующий .env остаётся основой: в нём могут быть правки, которых нет
# в .env.example пакета.
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
	cp .env.example "$INSTALL_DIR/.env"
fi

# Переустановка той же версии не должна затирать ссылку на предыдущую.
if [[ -n "$OLD_TAG" && "$OLD_TAG" != "$PKG_TAG" ]]; then
	PREV_TAG="$OLD_TAG"
else
	PREV_TAG="$OLD_PREV_TAG"
fi

set_env "$INSTALL_DIR/.env" TAG "$PKG_TAG"
set_env "$INSTALL_DIR/.env" PREV_TAG "$PREV_TAG"
set_env "$INSTALL_DIR/.env" COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"

if [[ "$ROLE" == "master" ]]; then
	set_env "$INSTALL_DIR/.env" VARAN_ROOT "$VARAN_ROOT"
	# FULL_AUTH запечён в образ фронта, на устройстве это справочное значение.
	set_env "$INSTALL_DIR/.env" FULL_AUTH "$(read_env .env.example FULL_AUTH)"
fi

# ========== Запуск ==========

echo "==> Запуск сервисов"
docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" up -d

echo "==> Ожидание готовности сервисов (до ${HEALTH_TIMEOUT}с)"
DEADLINE=$(( SECONDS + HEALTH_TIMEOUT ))
HEALTHY=1
while :; do
	PENDING=()
	for cid in $(docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" ps -q); do
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

# ========== Чистка старых образов ==========

echo "==> Чистка образов старше предыдущей версии"
docker image ls --format '{{.Repository}}:{{.Tag}}' --filter 'reference=varan/*' | while read -r img; do
	tag="${img##*:}"
	if [[ "$tag" == "$PKG_TAG" || ( -n "$PREV_TAG" && "$tag" == "$PREV_TAG" ) ]]; then
		continue
	fi
	echo "    удаляю $img"
	docker image rm "$img" >/dev/null 2>&1 || warn "не удалось удалить $img"
done

# ========== Итог ==========

echo
docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" ps
echo
echo "Роль:       $ROLE"
echo "Версия:     $PKG_TAG"
echo "Предыдущая: ${PREV_TAG:-нет}"
if [[ "$ROLE" == "master" ]]; then
	echo "VARAN_ROOT: $VARAN_ROOT"
fi
echo "Каталог:    $INSTALL_DIR"
echo "Откат:      sudo $INSTALL_DIR/rollback.sh"

if [[ "$HEALTHY" == "0" ]]; then
	echo
	die "часть сервисов не поднялась, смотрите docker compose logs"
fi

echo
echo "Установка завершена."
