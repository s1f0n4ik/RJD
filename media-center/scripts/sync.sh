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
    checks
    shaders
    proto
    server
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

# tar xzf только добавляет и перезаписывает: файлы, которых в этой ветке нет, остаются на устройстве
# и попадают в сборку через GLOB_RECURSE. Из каталогов кода убираем всё, чего нет локально.
# build/ не трогаем, сгенерированный proto лежит в нём.
PRUNE_DIRS=(src include checks proto shaders)
LOCAL_FILES=$(find "${PRUNE_DIRS[@]}" -type f | LC_ALL=C sort)
REMOTE_FILES=$(ssh "$REMOTE" "cd '$REMOTE_DIR' && find ${PRUNE_DIRS[*]} -type f" | LC_ALL=C sort)
# Пустой локальный список означал бы «удалить всё»: тогда не чистим
if [[ -n "$LOCAL_FILES" && -n "$REMOTE_FILES" ]]; then
    STALE=$(LC_ALL=C comm -23 <(printf '%s\n' "$REMOTE_FILES") <(printf '%s\n' "$LOCAL_FILES"))
    if [[ -n "$STALE" ]]; then
        log "Лишние файлы на устройстве, удаляю:"
        printf '%s\n' "$STALE" | ssh "$REMOTE" "cd '$REMOTE_DIR' && xargs -r -d '\n' rm -v"
    fi
fi

log "Готово"
