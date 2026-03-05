export GST_ROOT=/opt/gstreamer-1.28
export PATH=$GST_ROOT/bin:$PATH

# Удаление libsoup2 из запуска
export LD_LIBRARY_PATH=$(echo $LD_LIBRARY_PATH | tr ':' '\n' | grep -v 'libsoup-2' | paste -sd:)

export LD_LIBRARY_PATH=$GST_ROOT/lib/aarch64-linux-gnu:$GST_ROOT/lib:$LD_LIBRARY_PATH
export PKG_CONFIG_PATH=$GST_ROOT/lib/aarch64-linux-gnu/pkgconfig:$GST_ROOT/lib/pkgconfig:$PKG_CONFIG_PATH
export GST_PLUGIN_PATH=$GST_ROOT/lib/aarch64-linux-gnu/gstreamer-1.0
export GST_PLUGIN_SCANNER=$GST_ROOT/libexec/gstreamer-1.0/gst-plugin-scanner

#!/bin/bash
# 🔥 Запуск с аргументами: <rest_port> <signaling_ip> <signaling_port>
# По умолчанию: 7777 127.0.0.1 8765
REST_PORT="${1:-7777}"
SIGNALING_IP="${2:-127.0.0.1}"
SIGNALING_PORT="${3:-8765}"

exec /home/orangepi/RJD/RJD/media-center/build/media-center \
    "$REST_PORT" \
    "$SIGNALING_IP" \
    "$SIGNALING_PORT"
