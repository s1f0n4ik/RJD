#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
record_check_flags=""
if ! pkg-config --atleast-version=1.24 gstreamer-webrtc-1.0; then
    record_check_flags='-DGstWebRTCICE=GObject -Dgst_webrtc_ice_close(a,b)=abort()'
fi
g++ $record_check_flags -std=c++20 -O0 -w -pthread -ffunction-sections -fdata-sections -Wl,--gc-sections \
    -Iinclude -I3rdparty/boost/include -I3rdparty/glm \
    checks/record-stop-check.cpp src/pipelines/base_pipeline.cpp src/pipelines/stream-pipeline.cpp \
    src/webrtc_session.cpp src/archive/segment-writer.cpp src/utility/db-helper.cpp src/utility/frames.cpp \
    $(pkg-config --cflags --libs opencv4 gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 \
        gstreamer-allocators-1.0 gstreamer-webrtc-1.0 gstreamer-gl-1.0 gstreamer-sdp-1.0 egl glesv2) \
    -lsqlite3 -o /tmp/record-stop-check
/tmp/record-stop-check
