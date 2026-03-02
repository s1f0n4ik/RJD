FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ========== Установка ВСЕХ зависимостей из CMakeLists.txt ==========
RUN apt-get update && apt-get install -y \
    # Базовые инструменты сборки
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    git \
    # OpenCV
    libopencv-dev \
    # FFMPEG (libavcodec, libavformat, libavutil, libswscale, libavdevice)
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswscale-dev \
    libavdevice-dev \
    # GStreamer + плагины
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-tools \
    # GStreamer WebRTC
    gstreamer1.0-nice \
    libgstwebrtc-1.0-0 \
    libnice-dev \
    # OpenSSL и ZLIB
    libssl-dev \
    zlib1g-dev \
    # Дополнительные утилиты
    nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ========== Копируем исходники ==========
COPY . .

# ========== Устанавливаем пути для Boost из 3rdparty ==========
ENV BOOST_ROOT=/app/3rdparty/boost
ENV BOOST_INCLUDEDIR=/app/3rdparty/boost/include
ENV BOOST_LIBRARYDIR=/app/3rdparty/boost/lib

# ========== Сборка ==========
RUN mkdir -p build && cd build && \
    cmake -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DBOOST_ROOT=/app/3rdparty/boost \
        -DBoost_NO_SYSTEM_PATHS=ON \
        .. && \
    ninja

# ========== Переменные окружения для runtime ==========
ENV SIGNALING_SERVER=ws://signaling-server:8765
ENV LD_LIBRARY_PATH=/app/3rdparty/boost/lib:/usr/local/lib:$LD_LIBRARY_PATH

EXPOSE 8888

CMD ["/app/build/media-center"]