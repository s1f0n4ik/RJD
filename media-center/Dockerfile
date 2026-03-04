FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Установка зависимостей
RUN apt-get update && apt-get install -y \
    build-essential cmake ninja-build pkg-config git \
    libopencv-dev \
    libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavdevice-dev \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-tools gstreamer1.0-nice \
    libnice-dev libssl-dev zlib1g-dev nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем исходники
COPY . .

# Boost
ENV BOOST_ROOT=/app/3rdparty/boost
ENV BOOST_INCLUDEDIR=/app/3rdparty/boost/include
ENV BOOST_LIBRARYDIR=/app/3rdparty/boost/lib

# Сборка
RUN mkdir -p build && cd build && \
    cmake -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DBOOST_ROOT=/app/3rdparty/boost \
        -DBoost_NO_SYSTEM_PATHS=ON \
        .. && \
    ninja

ENV LD_LIBRARY_PATH=/app/3rdparty/boost/lib:/usr/local/lib:$LD_LIBRARY_PATH

# Порт 7777 для REST API управления
EXPOSE 7777

# Запуск через run.sh (если есть) или напрямую
#CMD ["/app/build/media-center"]
RUN chmod +x /app/run.sh
CMD ["/app/run.sh"]