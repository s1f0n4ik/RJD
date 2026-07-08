#!/usr/bin/env bash
# Заливка исходников media-center на устройство через tar-over-ssh.
# По умолчанию синхронизирует только код (быстро). Тяжелые зависимости 3rdparty
# (boost ~220MB) заливаются только при первом запуске или с флагом --deps.
#
# Использование:
#   sync.sh          заливка кода (+ 3rdparty при первом запуске)
#   sync.sh --deps   принудительно перезалить и 3rdparty

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$PROJECT_DIR"

# Что всегда заливаем
ITEMS=(
    CMakeLists.txt
    version.h.in
    .gitattributes
    .gitignore
    README.md
    src
    include
    shaders
    server
    gstreamer-mpp
)

# Заливать ли зависимости 3rdparty
FORCE_DEPS=false
[[ "${1:-}" == "--deps" ]] && FORCE_DEPS=true

if ! $FORCE_DEPS; then
    if ! ssh "$REMOTE" "[ -d '$REMOTE_DIR/3rdparty/boost/lib' ]" 2>/dev/null; then
        log "Зависимости 3rdparty на устройстве отсутствуют — будут залиты"
        FORCE_DEPS=true
    fi
fi

if $FORCE_DEPS; then
    ITEMS+=(3rdparty)
    log "Заливка кода + зависимостей 3rdparty (может занять время)"
else
    log "Заливка только кода"
fi

log "Цель: $REMOTE:$REMOTE_DIR"
ssh "$REMOTE" "mkdir -p '$REMOTE_DIR'"

tar czf - "${ITEMS[@]}" | ssh "$REMOTE" "tar xzf - -C '$REMOTE_DIR'"

log "Готово"
