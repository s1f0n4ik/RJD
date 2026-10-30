#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
g++ -std=c++20 -O1 -pthread -Wno-deprecated-enum-enum-conversion -Iinclude -I3rdparty/boost/include -I3rdparty/glm \
    checks/surround-config-check.cpp src/bird-view/linker-config.cpp \
    src/bird-view/linker-store.cpp src/bird-view/top-bake.cpp src/core/machine-config.cpp \
    $(pkg-config --cflags --libs opencv4 glesv2) -o /tmp/surround-config-check
/tmp/surround-config-check "$@"
