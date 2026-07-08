#!/usr/bin/env bash
# Общая конфигурация для скриптов удаленной сборки media-center на Orange Pi.
# Правится под конкретное устройство. Скрипты рассчитаны на запуск из Git Bash.

set -euo pipefail

# SSH-алиас устройства (описан в ~/.ssh/config -> orangepi-mc)
REMOTE="${MC_REMOTE:-orangepi-mc}"

# Каталог проекта на устройстве (создается автоматически)
REMOTE_DIR="${MC_REMOTE_DIR:-/home/orangepi/media-center-vscode}"

# Скрипт окружения GStreamer 1.28 на устройстве
GST_ENV="${MC_GST_ENV:-/opt/gstreamer-1.28/env.sh}"

# Тип сборки по умолчанию
BUILD_TYPE="${MC_BUILD_TYPE:-Release}"

# Корень локального проекта media-center (родитель каталога scripts)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Локальное зеркало системных заголовков устройства для IntelliSense
SYSROOT_DIR="${PROJECT_DIR}/.intellisense-sysroot"

# Цветной вывод статуса
log() { printf '\033[1;36m[media-center]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[media-center]\033[0m %s\n' "$*" >&2; }
