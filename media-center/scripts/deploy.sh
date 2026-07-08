#!/usr/bin/env bash
# Полный цикл: заливка кода + сборка на устройстве.
# Опционально запуск после успешной сборки.
#
# Использование:
#   deploy.sh           заливка + сборка
#   deploy.sh --run     заливка + сборка + запуск
#   deploy.sh --deps    заливка (с 3rdparty) + сборка

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DIR="$(dirname "${BASH_SOURCE[0]}")"

RUN=false
SYNC_ARGS=()
BUILD_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --run) RUN=true ;;
        --deps) SYNC_ARGS+=("--deps") ;;
        *) BUILD_ARGS+=("$arg") ;;
    esac
done

bash "$DIR/sync.sh" "${SYNC_ARGS[@]}"
bash "$DIR/build.sh" "${BUILD_ARGS[@]}"
$RUN && bash "$DIR/run.sh"

exit 0
