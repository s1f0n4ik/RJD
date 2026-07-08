#!/usr/bin/env bash
# Запуск собранного media-center на устройстве с окружением GStreamer 1.28.
#
# Приложение требует ровно 3 аргумента:
#   <rest_port> <signaling_ip> <signaling_port>
# По умолчанию используются те же, что в systemd-сервисе устройства.
# Значения можно переопределить аргументами или переменными окружения
# MC_REST_PORT / MC_SIGNALING_IP / MC_SIGNALING_PORT.
#
# Mali EGL на устройстве собран под X11, поэтому нужен доступ к активной
# графической сессии (DISPLAY=:0 + XAUTHORITY). Без этого eglInitialize падает.
# На устройстве должна быть запущена графическая сессия orangepi (seat0/tty1).
#
# Использование:
#   run.sh                                  запуск с параметрами по умолчанию
#   run.sh 7777 127.0.0.1 8765              запуск со своими параметрами

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REST_PORT="${1:-${MC_REST_PORT:-7777}}"
SIGNALING_IP="${2:-${MC_SIGNALING_IP:-127.0.0.1}}"
SIGNALING_PORT="${3:-${MC_SIGNALING_PORT:-8765}}"

# Окружение графической сессии для Mali EGL (X11)
DISPLAY_ENV="${MC_DISPLAY:-:0}"
XAUTH_ENV="${MC_XAUTHORITY:-/home/orangepi/.Xauthority}"
XDG_ENV="${MC_XDG_RUNTIME_DIR:-/run/user/1000}"

log "Запуск media-center на $REMOTE: rest=$REST_PORT signaling=$SIGNALING_IP:$SIGNALING_PORT (DISPLAY=$DISPLAY_ENV)"

# -t для интерактивного вывода и корректной обработки Ctrl-C
ssh -t "$REMOTE" "source '$GST_ENV'; \
    export DISPLAY='$DISPLAY_ENV' XAUTHORITY='$XAUTH_ENV' XDG_RUNTIME_DIR='$XDG_ENV'; \
    cd '$REMOTE_DIR/build' && ./media-center $REST_PORT $SIGNALING_IP $SIGNALING_PORT"
