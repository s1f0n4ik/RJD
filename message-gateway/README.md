# message-gateway

Отдельный сервис-шлюз обмена сообщениями. media-center отдаёт **семантику**
(кадр: изображение + детекции + мета + версия протокола) по gRPC, шлюз проверяет
поддержку версии, кодирует под конкретный протокол и отправляет стороннему
клиенту (КАУС). Сейчас реализован транспорт WebSocket; CAN/Modbus добавляются
новой реализацией `ITransport` без изменения остального кода.

Смысл слоя — развязка: при смене wire-формата протокола правится кодек в шлюзе,
ядро C++ не трогается и не пересобирается.

Два интерфейса:
- **gRPC (порт 50051)** — ingress кадров. Высокочастотный путь с изображением,
  поэтому gRPC (потоковый), а не HTTP.
- **REST (порт 9090)** — настроечные ручки. Их дёргает веб-страница по запросу.

## Структура

```
proto/
  frame-ingress.proto  gRPC-контракт ingress кадров
include/gateway/
  log.h              ULog — потокобезопасный логгер
  config.h           FGatewayConfig / FWsConfig + json
  ws-client.h        UWebSocketClient (адаптирован из media-center)
  transport.h        ITransport + UWsTransport
  message.h          FFrameMessage / FDetection (семантическая модель)
  frame-sink.h       IFrameSink + FSubmitResult (ingress → ядро)
  codec.h            ICodec + UCodecRegistry (версии протокола)
  frame-codec-v1.h   UFrameCodecV1
  http-server.h      URouter / UHttpSession / UListener (REST, из media-center)
  grpc-ingress.h     UGrpcIngress — gRPC-сервер приёма кадров
  gateway.h          UGateway — оркестратор
src/
  frame-codec-v1.cpp  раскладка байт протокола v1
  grpc-ingress.cpp    сервис FrameIngress, конверсии proto <-> модель
  gateway.cpp         REST-маршруты, submit_frame, heartbeat
  main.cpp            запуск, флаги, сигналы
```

## Сборка

Все зависимости ставятся в контейнере apt-ом, CMake подбирает их через
`find_package`. Отдельно вендорить ничего не нужно.

```
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
```

Нужны (в образе уже прописаны в Dockerfile): C++20, `libboost-dev`,
`libboost-json-dev`, `protobuf-compiler`, `protobuf-compiler-grpc`,
`libprotobuf-dev`, `libgrpc++-dev`. Сборка идёт под Linux (контейнер).

## Запуск

```
./message-gateway --rest-port 9090 --grpc-port 50051 \
    --ws-host 192.168.1.50 --ws-port 8080 --ws-target /ws/frames --heartbeat 5
```

Все параметры опциональны; WebSocket дальше настраивается в рантайме через REST.
WebSocket-клиент к КАУС переподключается бесконечно (каждые 10 с), даже если
попытки неуспешны.

## gRPC ingress кадров

Контракт — [proto/frame-ingress.proto](proto/frame-ingress.proto):

```proto
service FrameIngress {
    rpc StreamFrames(stream FrameRequest) returns (stream FrameReply); // видеопоток
    rpc SendFrame(FrameRequest) returns (FrameReply);                  // одиночный
}
```

`FrameRequest` — семантическая модель (не wire-формат): `ver`, `id`, `ts`,
`width/height/format`, повторяемые `dets` и `image` (сырые байты, поле `bytes`).

Для видеопотока media-center открывает **один** `StreamFrames` и шлёт кадры
подряд, получая `FrameReply` на каждый. Шлюз по `ver` находит кодек:
- нет кодека → `FrameReply{accepted:false, error:"unsupported ... (supported: 1)"}`,
  поток не рвётся;
- нет соединения с КАУС → `accepted:false, error:"websocket not connected"`
  (кадры не буферизуются, чтобы очередь не росла);
- успех → `accepted:true, transport:"websocket", wire_size:...`.

Кодек v1 собирает wire-кадр протокола: `[uint32 BE длина JSON][JSON-заголовок]
[image bytes]`, шлёт бинарным WS-фреймом. При простое канала шлюз сам шлёт
heartbeat каждые `heartbeat_sec` секунд.

## REST API (настройка)

| Метод | Путь | Назначение |
|-------|------|------------|
| GET  | `/health` | статус сервиса и признак соединения с КАУС |
| GET  | `/config` | текущая конфигурация |
| PUT  | `/config/websocket` | обновить host/port/target/enabled и переподключиться |
| POST | `/ws/connect` | поднять WebSocket-соединение |
| POST | `/ws/disconnect` | закрыть соединение |
| GET  | `/ws/status` | состояние WebSocket |
| GET  | `/protocol/versions` | поддерживаемые версии сообщений |

Наружу REST проксируется nginx под `/api/gateway/*`. gRPC-ingress внутренний
(media-center → localhost:50051), через nginx не публикуется.

### PUT /config/websocket

Частичное обновление, тело JSON:

```json
{ "host": "192.168.1.50", "port": "8080", "target": "/ws/frames", "enabled": true }
```

## Замечания

- ingress держим **семантическим**. Если начнёте гонять через шлюз уже собранные
  wire-кадры «как есть» — слой становится чистым проксированием, тогда дешевле
  слать из media-center напрямую.
- при отсутствии соединения кадры не буферизуются, чтобы очередь отправки не
  росла бесконтрольно.
