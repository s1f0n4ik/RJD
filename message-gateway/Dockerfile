FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# docker-clean удаляет скачанные пакеты после установки и обесценивает
# кеш-маунт, поэтому его убираем. Списки apt лежат на маунте и в слой образа
# не попадают, чистить их вручную не нужно.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    pkg-config \
    ca-certificates \
    # boost: beast/asio (header-only) + json (скомпилированная часть)
    libboost-dev \
    libboost-json-dev \
    # protobuf + gRPC для ingress кадров
    protobuf-compiler \
    protobuf-compiler-grpc \
    libprotobuf-dev \
    libgrpc++-dev

WORKDIR /app

COPY . .

RUN cmake -B build -S . \
    -DCMAKE_BUILD_TYPE=Release

RUN cmake --build build -j

WORKDIR /app/build

# REST 9090 (настройка), gRPC 50051 (ingress кадров). Адрес КАУС настраивается
# в рантайме через REST либо флагами --ws-host/--ws-port.
ENTRYPOINT ["./message-gateway"]
