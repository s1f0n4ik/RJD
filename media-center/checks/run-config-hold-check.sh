#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
g++ -std=c++20 -O1 -pthread -Iinclude -I3rdparty/boost/include \
    checks/config-hold-check.cpp src/core/machine-config.cpp src/main-server/config-controller.cpp \
    src/core/websocket-handler.cpp -o /tmp/config-hold-check
/tmp/config-hold-check
