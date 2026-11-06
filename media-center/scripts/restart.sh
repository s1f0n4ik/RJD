#!/usr/bin/env bash
# Остановка и запуск пользовательской копии media-center на устройстве.
#
# Использование:
#   restart.sh            остановить работающий процесс и запустить новый (по умолчанию)
#   restart.sh stop       только остановить и дождаться выключения
#   restart.sh start      только запустить в tmux-сессии mc (не трогает уже работающий)
#
# Процесс останавливается по SIGINT (ждём до 60 с). Останавливается только потомок панели tmux mc
# с бинарником $REMOTE_DIR/build/media-center: чужие media-center не трогаются. Если mc не запущен,
# stop ничего не делает. Параметры запуска те же, что у run.sh. MC_FOLLOW=1 после запуска оставляет
# задачу открытой и показывает вывод media-center (tmux только чтение; остановка задачи его не останавливает).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DIR="$(dirname "${BASH_SOURCE[0]}")"

stop_mc() {
    log "Остановка media-center на $REMOTE"
    ssh "$REMOTE" bash -s -- "$REMOTE_DIR/build" <<'EOF'
B="$1"
PANE=$(tmux display -p -t mc:0.0 "#{pane_pid}" 2>/dev/null)
P=$([ -n "$PANE" ] && pgrep -x -P "$PANE" media-center)
if [ -n "$P" ]; then
    # После пересборки бинарник заменён, и ссылка на него помечается «(deleted)»
    EXE=$(readlink "/proc/$P/exe")
    [ "${EXE% (deleted)}" = "$B/media-center" ] || { echo "PID $P is $EXE, not $B/media-center: abort"; exit 1; }
    echo "stopping media-center $P (SIGINT)"
    kill -INT "$P"
    for _ in $(seq 60); do kill -0 "$P" 2>/dev/null || break; sleep 1; done
    kill -0 "$P" 2>/dev/null && { echo "media-center $P still running after 60 s: abort"; exit 1; }
    echo "media-center stopped"
else
    echo "media-center is not running"
fi
pgrep -a -x media-center && { echo "another media-center is running: abort"; exit 1; }
exit 0
EOF
}

start_mc() {
    MC_DETACH=1 bash "$DIR/run.sh"

    if [ -n "${MC_FOLLOW:-}" ]; then
        log "Вывод media-center (tmux mc, только чтение): остановка задачи его не останавливает"
        ssh -t "$REMOTE" "tmux attach-session -r -t mc"
    fi
}

case "${1:-restart}" in
    stop) stop_mc ;;
    start) start_mc ;;
    restart) stop_mc; start_mc ;;
    *) err "Неизвестный режим '$1': stop, start или restart"; exit 2 ;;
esac
