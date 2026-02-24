# Базовый образ с GStreamer и необходимыми зависимостями
FROM ubuntu:22.04

# Отключаем интерактивные запросы
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Установка системных зависимостей
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    libopencv-dev \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswscale-dev \
    libavdevice-dev \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    libssl-dev \
    libboost-all-dev \
    zlib1g-dev \
    nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*

# Копируем Boost (если используете свою версию)
COPY 3rdparty/boost /app/3rdparty/boost

# Копируем исходники
COPY include /app/include
COPY src /app/src
COPY CMakeLists.txt /app/
COPY CMakePresets.json /app/

# Сборка проекта
RUN mkdir -p /app/build && cd /app/build && \
    cmake -G Ninja -DCMAKE_BUILD_TYPE=Release .. && \
    ninja

# Открываем порт (если нужен для управления)
EXPOSE 8765

# Запуск
CMD ["/app/build/media-center"]