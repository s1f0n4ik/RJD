#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
g++ -std=c++20 -O1 -Iinclude -I3rdparty/boost/include checks/stream-error-check.cpp -o /tmp/stream-error-check
/tmp/stream-error-check
