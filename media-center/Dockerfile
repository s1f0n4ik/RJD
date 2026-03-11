FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    pkg-config \
    wget \
    ca-certificates \
    libglib2.0-dev libgtk-3-dev \
    zlib1g-dev libjpeg-dev libpng-dev libtiff-dev \
    libdrm-dev libegl1-mesa-dev libgles2-mesa-dev \
    libgl1-mesa-dev libglu1-mesa-dev mesa-utils \
    # GStreamer 1.28 и плагины
    gstreamer1.0-tools \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-good1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    gstreamer1.0-libav \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    # FFmpeg
    ffmpeg \
    # OpenCV
    libopencv-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
COPY ./gstreamer-mpp/ /usr/

COPY ./gstreamer-mpp/fix.sh /usr/local/bin/fix.sh
RUN chmod +x /usr/local/bin/fix.sh

RUN /usr/local/bin/fix.sh

ENV LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu:/usr/lib
ENV GST_PLUGIN_PATH=/usr/lib/aarch64-linux-gnu/gstreamer-1.0
ENV GST_PLUGIN_SCANNER=/usr/libexec/gstreamer-1.0/gst-plugin-scanner

RUN cmake -B build -S . \ 
    -DCMAKE_BUILD_TYPE=Release

RUN cmake --build build -j

WORKDIR /app/build

ENTRYPOINT ["./media-center"]