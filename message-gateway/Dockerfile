FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ca-certificates \
    # boost: beast/asio (header-only) + json (скомпилированная часть)
    libboost-dev \
    libboost-json-dev \
    # protobuf + gRPC для ingress кадров
    protobuf-compiler \
    protobuf-compiler-grpc \
    libprotobuf-dev \
    libgrpc++-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN cmake -B build -S . \
    -DCMAKE_BUILD_TYPE=Release

RUN cmake --build build -j

WORKDIR /app/build

# REST 9090 (настройка), gRPC 50051 (ingress кадров). Адрес КАУС настраивается
# в рантайме через REST либо флагами --ws-host/--ws-port.
ENTRYPOINT ["./message-gateway"]
