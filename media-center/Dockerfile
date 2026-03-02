FROM ubuntu:22.04

# Устанавливаем базовые зависимости
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    libboost-all-dev \
    libssl-dev \
    nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем исходники
COPY . .

# Сборка
RUN mkdir -p build && cd build && \
    cmake -G Ninja -DCMAKE_BUILD_TYPE=Release .. && \
    ninja

# ВАЖНО: Передаём адрес signaling сервера через переменную окружения
ENV SIGNALING_SERVER=ws://signaling-server:8765

EXPOSE 8888

CMD ["/app/build/camera-threads-varan"]