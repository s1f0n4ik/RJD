#!/usr/bin/env bash
# Конфигурация и сборка media-center на устройстве.
# Экспортирует compile_commands.json для IntelliSense.
#
# Использование:
#   build.sh              сборка (тип из MC_BUILD_TYPE, по умолчанию Release)
#   build.sh Debug        сборка в Debug
#   build.sh --clean      удалить каталог build перед конфигурацией

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CLEAN=false
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=true ;;
        Debug|Release|RelWithDebInfo|MinSizeRel) BUILD_TYPE="$arg" ;;
    esac
done

# Число потоков сборки (MC_BUILD_JOBS). 8 — все ядра платы: 2026-11-05 вместе с работающим media-center
# плата перезагружалась на такой сборке, поэтому deploy.sh --restart собирает на выключенном media-center
JOBS="${MC_BUILD_JOBS:-8}"

log "Сборка на $REMOTE ($BUILD_TYPE, -j$JOBS), каталог $REMOTE_DIR"

ssh "$REMOTE" bash -s <<EOF
set -e
source "$GST_ENV"
cd "$REMOTE_DIR"
$( $CLEAN && echo "rm -rf build" )
cmake -B build -S . \
    -DCMAKE_BUILD_TYPE=$BUILD_TYPE \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build -j$JOBS
EOF

log "Сборка завершена. Бинарник: $REMOTE_DIR/build/media-center"
