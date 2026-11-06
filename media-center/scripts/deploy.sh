#!/usr/bin/env bash
# Полный цикл: заливка кода + сборка на устройстве.
# Опционально запуск после успешной сборки.
#
# Использование:
#   deploy.sh           заливка + сборка
#   deploy.sh --run     заливка + сборка + запуск
#   deploy.sh --restart остановка работающего media-center, заливка, сборка и запуск нового (restart.sh);
#                       при сбое заливки или сборки запускается прежний бинарник;
#                       с MC_FOLLOW=1 после запуска показывает вывод media-center
#   deploy.sh --deps    заливка (с 3rdparty) + сборка

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DIR="$(dirname "${BASH_SOURCE[0]}")"

RUN=false
RESTART=false
SYNC_ARGS=()
BUILD_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --run) RUN=true ;;
        --restart) RESTART=true ;;
        --deps) SYNC_ARGS+=("--deps") ;;
        *) BUILD_ARGS+=("$arg") ;;
    esac
done

# Сборка идёт на выключенном media-center: вместе с ним плата перегружалась и перезагружалась
$RESTART && bash "$DIR/restart.sh" stop

if ! { bash "$DIR/sync.sh" "${SYNC_ARGS[@]}" && bash "$DIR/build.sh" "${BUILD_ARGS[@]}"; }; then
    err "Заливка или сборка не удалась"
    if $RESTART; then
        err "Запускаю прежний бинарник"
        MC_FOLLOW= bash "$DIR/restart.sh" start
    fi
    exit 1
fi

$RUN && bash "$DIR/run.sh"
$RESTART && bash "$DIR/restart.sh" start

exit 0
