#!/usr/bin/env bash
# Установка роли из файла обновления varan на устройстве. Запускается из каталога
# роли (master/ или minion/) распакованного файла, от root:
#
#   sudo ./install.sh              установка
#   sudo ./install.sh --prepare    подготовка без остановки: загрузка образов, проверка ядра
#   sudo ./install.sh --discard    удаление подготовленных образов этой версии
#
# VARAN_UNATTENDED=1 — запуск службой обновления: без вопросов, служба обновления
# не переставляется (она обновляет себя сама последней).
#
# Состояние развёртывания (compose, .env, rollback.sh, пакеты ядра) живёт в
# /opt/varan-<роль> и переживает смену версий: каталог пакета одноразовый.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Сколько ждём, пока все сервисы станут healthy.
HEALTH_TIMEOUT=180

MODE="install"
for arg in "$@"; do
	case "$arg" in
		--prepare) MODE="prepare" ;;
		--discard) MODE="discard" ;;
		*) echo "ОШИБКА: неизвестный аргумент: $arg" >&2; exit 1 ;;
	esac
done
UNATTENDED="${VARAN_UNATTENDED:-0}"

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

missing_images() {
	# Образы версии пакета, которых ещё нет на устройстве
	local img
	while read -r img; do
		docker image inspect "$img" >/dev/null 2>&1 || echo "$img"
	done < <(TAG="$PKG_TAG" docker compose -f docker-compose.yml config --images)
}

load_images() {
	local missing
	missing="$(missing_images)"
	if [[ -z "$missing" ]]; then
		echo "==> Образы $PKG_TAG уже загружены"
		return 0
	fi
	[[ -n "$IMAGES_FILE" ]] || die "в каталоге пакета нет images.tar.gz, а образов нет на устройстве: $missing"
	echo "==> Загрузка образов"
	# Дельта несёт только новые слои: без нужных старых слоёв загрузка падает, ничего не меняя
	docker load -i "$IMAGES_FILE" || die "образы не загрузились: на устройстве нет слоёв, от которых собрана дельта, нужен файл от версии ${OLD_TAG:-этого устройства} или полный файл"
	missing="$(missing_images)"
	[[ -z "$missing" ]] || die "после загрузки нет образов: $missing"
}

check_mc_libs() {
	# Бинарник нового ядра проверяется во временном каталоге, до остановки чего-либо
	local tmp missing count
	tmp="$(mktemp -d)"
	dpkg-deb -x "$MC_DEB" "$tmp"
	missing="$(bash -c 'source /opt/gstreamer-1.28/env.sh >/dev/null 2>&1; ldd "$1"' _ "$tmp/opt/media-center/media-center" | grep 'not found' || true)"
	count="$(bash -c 'source /opt/gstreamer-1.28/env.sh >/dev/null 2>&1; ldd "$1"' _ "$tmp/opt/media-center/media-center" | grep -c '=>' || true)"
	rm -rf "$tmp"
	[[ -z "$missing" ]] || die "новому ядру не хватает библиотек:
$missing"
	echo "    проверка ядра: все $count библиотек найдены"
}

mc_flags_from_unit() {
	# Флаги ядра из ExecStart старого юнита: всё после бинарника media-center
	awk '/^ExecStart=/{on=1} on{line=$0; sub(/[ \t\r]+$/,"",line); cont=(substr(line,length(line),1)=="\\"); if(cont) line=substr(line,1,length(line)-1); printf "%s ", line; if(!cont) exit}' "$1" \
		| sed -E "s/.*\/media-center[[:space:]]+//; s/'[[:space:]]*$//; s/--journal-dir[= ][^[:space:]]*//; s/[[:space:]]+/ /g; s/^ //; s/ $//"
}

wait_mc() {
	local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
	until curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:7777/system/info; do
		(( SECONDS < deadline )) || return 1
		sleep 3
	done
}

# ========== Проверки окружения ==========

[[ "$(id -u)" == "0" ]] || die "нужны права root, запускайте через sudo"

ARCH="$(uname -m)"
[[ "$ARCH" == "aarch64" ]] || die "пакет собран под aarch64, здесь $ARCH"

command -v docker >/dev/null || die "не найден docker"
docker compose version >/dev/null 2>&1 || die "не найден плагин docker compose"
docker info >/dev/null 2>&1 || die "демон docker недоступен"

for f in docker-compose.yml .env.example; do
	[[ -f "$f" ]] || die "в каталоге пакета нет $f"
done

IMAGES_FILE=""
for f in images.tar.gz images.tar; do
	if [[ -f "$f" ]]; then
		IMAGES_FILE="$f"
		break
	fi
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

# Ядро и служба обновления лежат уровнем выше каталога роли; ставятся вместе с ролью исполнителя
MC_DEB=""
UPDATER_DEB=""
if [[ "$ROLE" == "minion" ]]; then
	[[ -f ../media-center.deb ]] && MC_DEB="$(cd .. && pwd)/media-center.deb"
	[[ -f ../updater.deb ]] && UPDATER_DEB="$(cd .. && pwd)/updater.deb"
fi

# ========== Подготовка и удаление подготовленного ==========

if [[ "$MODE" == "discard" ]]; then
	if [[ "$PKG_TAG" == "$OLD_TAG" || "$PKG_TAG" == "$OLD_PREV_TAG" ]]; then
		echo "==> Образы $PKG_TAG используются установкой, оставлены"
		exit 0
	fi
	echo "==> Удаление подготовленных образов $PKG_TAG"
	while read -r img; do
		docker image rm "$img" >/dev/null 2>&1 && echo "    удалён $img" || true
	done < <(TAG="$PKG_TAG" docker compose -f docker-compose.yml config --images)
	exit 0
fi

echo "==> Роль: $ROLE, версия пакета: $PKG_TAG"
if [[ -n "$OLD_TAG" ]]; then
	echo "==> Установлено сейчас: $OLD_TAG"
else
	echo "==> Установки на этом устройстве ещё не было"
fi

load_images
if [[ -n "$MC_DEB" ]]; then
	check_mc_libs
elif [[ "$ROLE" == "minion" ]]; then
	warn "в пакете нет media-center.deb — ядро не меняется"
fi

if [[ "$MODE" == "prepare" ]]; then
	echo "Подготовка завершена, работающие сервисы не тронуты."
	exit 0
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

	if [[ "$UNATTENDED" == "1" ]]; then
		VARAN_ROOT="$DEFAULT_ROOT"
	else
		[[ -t 0 ]] || die "нужен интерактивный терминал: скрипт спрашивает корень varan (ssh -t)"

		echo
		echo "Корень рабочего каталога varan. В нём лежит settings/devices.json —"
		echo "реестр устройств мастера. Enter оставит значение по умолчанию."
		read -r -p "VARAN_ROOT [$DEFAULT_ROOT]: " VARAN_ROOT
		VARAN_ROOT="${VARAN_ROOT:-$DEFAULT_ROOT}"
		echo
	fi
	[[ "$VARAN_ROOT" == /* ]] || die "путь должен быть абсолютным: $VARAN_ROOT"

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

# Ядро останавливается первым: оно пишет через storage-service и шлёт в сигналинг.
if [[ -n "$MC_DEB" ]] && systemctl is-active --quiet media-center.service; then
	echo "==> Остановка media-center"
	systemctl stop media-center.service
fi

if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
	echo "==> Остановка текущей версии"
	docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" down
fi

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

# ========== Ядро и служба обновления (роль исполнителя) ==========

if [[ -n "$MC_DEB" ]]; then
	# Юнит в /etc перекрыл бы юнит пакета: его флаги переезжают в /etc/default/media-center
	OLD_UNIT=/etc/systemd/system/media-center.service
	if [[ -f "$OLD_UNIT" ]]; then
		if [[ ! -f /etc/default/media-center ]]; then
			MC_ARGS="$(mc_flags_from_unit "$OLD_UNIT")"
			[[ "$MC_ARGS" == *--rest-port* ]] || die "не удалось разобрать флаги ядра из $OLD_UNIT, перенесите их в /etc/default/media-center вручную (MC_ARGS=\"...\")"
			printf '# Флаги ядра перенесены из %s\nMC_ARGS="%s"\n' "$OLD_UNIT" "$MC_ARGS" > /etc/default/media-center
			echo "==> Флаги ядра перенесены в /etc/default/media-center: $MC_ARGS"
		fi
		systemctl disable media-center.service >/dev/null 2>&1 || true
		mv "$OLD_UNIT" "$INSTALL_DIR/media-center.service.old"
		systemctl daemon-reload
		echo "    старый юнит сохранён: $INSTALL_DIR/media-center.service.old"
	fi

	# Пакеты ядра хранятся по версиям: rollback.sh ставит пакет той версии, на которую возвращается
	mkdir -p "$INSTALL_DIR/debs"
	cp "$MC_DEB" "$INSTALL_DIR/debs/media-center_$PKG_TAG.deb"
	echo "==> Установка ядра $(dpkg-deb -f "$MC_DEB" Version)"
	dpkg -i "$MC_DEB"
fi

if [[ -n "$UPDATER_DEB" && "$UNATTENDED" != "1" ]]; then
	echo "==> Установка службы обновления $(dpkg-deb -f "$UPDATER_DEB" Version)"
	dpkg -i "$UPDATER_DEB"
fi

if [[ "$ROLE" == "master" && -f /lib/systemd/system/update-master.service ]]; then
	systemctl enable --now update-master.service >/dev/null 2>&1 || warn "не удалось включить update-master"
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

MC_OK=1
if [[ -n "$MC_DEB" ]]; then
	echo "==> Запуск media-center"
	systemctl start media-center.service
	if ! wait_mc; then
		warn "media-center не ответил на /system/info за ${HEALTH_TIMEOUT}с, смотрите journalctl -u media-center"
		MC_OK=0
	fi
fi

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

for deb in "$INSTALL_DIR"/debs/media-center_*.deb; do
	[[ -f "$deb" ]] || continue
	tag="$(basename "$deb" .deb)"
	tag="${tag#media-center_}"
	if [[ "$tag" != "$PKG_TAG" && "$tag" != "$PREV_TAG" ]]; then
		rm -f "$deb"
	fi
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
if [[ -n "$MC_DEB" ]]; then
	echo "Ядро:       $(dpkg-query -W -f='${Version}' media-center 2>/dev/null), флаги в /etc/default/media-center"
fi
echo "Каталог:    $INSTALL_DIR"
echo "Откат:      sudo $INSTALL_DIR/rollback.sh"

if [[ "$HEALTHY" == "0" ]]; then
	echo
	die "часть сервисов не поднялась, смотрите docker compose logs"
fi

if [[ "$MC_OK" == "0" ]]; then
	echo
	die "media-center не поднялся"
fi

echo
echo "Установка завершена."
