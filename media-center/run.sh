#!/bin/bash

# Указываем путь к кастомному GStreamer
export GST_ROOT=/opt/gstreamer-1.28
export PATH=$GST_ROOT/bin:$PATH

# Убираем libsoup3 из LD_LIBRARY_PATH, если есть
export LD_LIBRARY_PATH=$(echo $LD_LIBRARY_PATH | tr ':' '\n' | grep -v 'libsoup-3' | paste -sd:)
export LD_LIBRARY_PATH=$GST_ROOT/lib/aarch64-linux-gnu:$GST_ROOT/lib:$LD_LIBRARY_PATH

# PKG_CONFIG и плагины
export PKG_CONFIG_PATH=$GST_ROOT/lib/aarch64-linux-gnu/pkgconfig:$GST_ROOT/lib/pkgconfig:$PKG_CONFIG_PATH
export GST_PLUGIN_PATH=$GST_ROOT/lib/aarch64-linux-gnu/gstreamer-1.0
export GST_PLUGIN_SCANNER=$GST_ROOT/libexec/gstreamer-1.0/gst-plugin-scanner

# Запускаем бинарник с аргументами
exec /home/orangepi/.vs/media-center/out/build/linux-debug/media-center "$@"
