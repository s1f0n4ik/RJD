#!/bin/bash

# Настройка путей к библиотекам GStreamer
export GST_ROOT=/opt/gstreamer-1.28
export PATH=$GST_ROOT/bin:$PATH

# Убираем libsoup3 из LD_LIBRARY_PATH, если нужно
export LD_LIBRARY_PATH=$(echo $LD_LIBRARY_PATH | tr ':' '\n' | grep -v 'libsoup-3' | paste -sd:)
export LD_LIBRARY_PATH=$GST_ROOT/lib/aarch64-linux-gnu:$GST_ROOT/lib:/home/orangepi/RJD/RJD/media-center/3rdparty/boost/lib:$LD_LIBRARY_PATH

# PKG_CONFIG и плагины
export PKG_CONFIG_PATH=$GST_ROOT/lib/aarch64-linux-gnu/pkgconfig:$GST_ROOT/lib/pkgconfig:$PKG_CONFIG_PATH
export GST_PLUGIN_PATH=$GST_ROOT/lib/aarch64-linux-gnu/gstreamer-1.0
export GST_PLUGIN_SCANNER=$GST_ROOT/libexec/gstreamer-1.0/gst-plugin-scanner

# Signaling Server
export SIGNALING_SERVER=ws://localhost:8765

# Запускаем приложение
exec /home/orangepi/RJD/RJD/media-center/build/media-center "$@"