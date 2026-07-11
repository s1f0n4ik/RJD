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
  stats.h            UStats — счётчики + кольцо последних сообщений
  integration.h      IIntegration — контракт конфигурации доставки
  rsm2000-integration.h  URsm2000Integration — РСМ-2000 (WebSocket)
  timesource.h       UTimeSource — время + GPS для остальных сервисов
  http-server.h      URouter / UHttpSession / UListener (REST, из media-center)
  grpc-ingress.h     UGrpcIngress — gRPC-сервер приёма кадров
  gateway.h          UGateway — оркестратор
src/
  frame-codec-v1.cpp       раскладка байт протокола v1
  rsm2000-integration.cpp  логика РСМ-2000: кодирование + WS + heartbeat + stats
  grpc-ingress.cpp         сервис FrameIngress, конверсии proto <-> модель
  gateway.cpp              реестр интеграций, REST-маршруты, делегирование
  main.cpp                 запуск, флаги, сигналы
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

## Интеграции (конфигурации)

Доставка кадров вынесена за интерфейс `IIntegration` ([include/gateway/integration.h](include/gateway/integration.h)):
интеграция получает кадр из ingress и применяет **свою** логику (кодирование +
транспорт), ведёт свою статистику и heartbeat. Сейчас реализована одна —
**РСМ-2000** ([rsm2000-integration.h](include/gateway/rsm2000-integration.h),
передача по WebSocket). CAN/Modbus и прочие добавляются новой реализацией
`IIntegration` и `push_back` в `setup_integrations()`; ядро не меняется.

Активна одновременно одна интеграция; `submit_frame` делегируется ей. Выбор — по
REST (`POST /integrations/select`).

Конфигурация задаёт **набор модулей** доставки (`modules`) и их настройки по
умолчанию. Модуль — это канал со своими настройками, состоянием соединения и
статистикой. У РСМ-2000 сейчас один модуль — `websocket`; при добавлении CAN/Modbus
в набор конфигурации массив `modules` расширяется. Страница КРСПС рисует каждый
модуль отдельным разделом в левом столбце.

## REST API (настройка)

| Метод | Путь | Назначение |
|-------|------|------------|
| GET  | `/health` | статус сервиса, соединение с КАУС, id активной интеграции |
| GET  | `/integrations` | список конфигураций + активная |
| POST | `/integrations/select` | выбрать активную конфигурацию `{ "id": "rsm-2000" }` |
| GET  | `/status` | полный статус активной: соединение + счётчики + последние сообщения |
| GET  | `/config` | конфигурация активной интеграции |
| PUT  | `/config/websocket` | обновить host/port/target/enabled/heartbeat_sec и переподключиться |
| POST | `/ws/connect` | поднять активную интеграцию (транспорт) |
| POST | `/ws/disconnect` | погасить активную интеграцию |
| GET  | `/ws/status` | состояние соединения активной интеграции |
| GET  | `/protocol/versions` | поддерживаемые версии сообщений |
| GET  | `/time` (`/gps`) | точка входа времени и GPS для остальных сервисов |

Наружу REST проксируется nginx под `/api/gateway/*`. gRPC-ingress внутренний
(media-center → localhost:50051), через nginx не публикуется.

### GET /status

Снимок активной конфигурации со всеми её модулями — то, что рисует страница КРСПС.
`/config` возвращает ту же структуру:

```json
{
  "id": "rsm-2000", "title": "РСМ-2000",
  "description": "Передача обнаружений в АС КРСПС по протоколу v1 через WebSocket с heartbeat.",
  "modules": [
    {
      "id": "websocket", "title": "WebSocket", "transport": "websocket",
      "heartbeat_sec": 5, "protocol_versions": [1],
      "connection": { "connected": true, "enabled": true,
                      "url": "ws://192.168.1.50:8080/ws/frames",
                      "host": "192.168.1.50", "port": "8080", "target": "/ws/frames" },
      "stats": {
        "messages": 12847, "detections": 3219, "images": 12640, "bytes": 5046272000,
        "heartbeats": 142, "rejected": 3,
        "recent": [ { "seq": 12989, "id": 48213, "ts": 1718700000000, "ver": 1,
                      "detections": 3, "wire_size": 188416, "kind": "frame", "status": "sent" } ]
      }
    }
  ]
}
```

`/integrations` отдаёт список конфигураций для выбора (карточками): каждый элемент —
`{ id, title, description, connected, modules:[{ id, title, transport }] }`.

### PUT /config/websocket

Частичное обновление, тело JSON:

```json
{ "host": "192.168.1.50", "port": "8080", "target": "/ws/frames", "enabled": true, "heartbeat_sec": 5 }
```

### GET /time

Время (пока серверные часы шлюза) и GPS (пока захардкожен). Общая точка входа
для остальных сервисов; позже подключится реальный источник GNSS/модема.

```json
{
  "unix_ms": 1718700000000, "unix_s": 1718700000, "iso": "2024-06-18T08:00:00Z",
  "gps": { "lat": 55.7695, "lon": 37.6626, "alt": 150.0, "valid": true, "sats": 11, "speed": 0.0, "course": 0.0 },
  "source": { "time": "server", "gps": "static" }
}
```

## Замечания

- ingress держим **семантическим**. Если начнёте гонять через шлюз уже собранные
  wire-кадры «как есть» — слой становится чистым проксированием, тогда дешевле
  слать из media-center напрямую.
- при отсутствии соединения кадры не буферизуются, чтобы очередь отправки не
  росла бесконтрольно.
