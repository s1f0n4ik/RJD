# message-gateway

Отдельный сервис-шлюз обмена сообщениями. media-center отдаёт **семантику**
(кадр: изображение + детекции + мета + версия протокола) по gRPC, шлюз проверяет
поддержку версии, кодирует под конкретный протокол и отправляет стороннему
клиенту. Реализованы два канала: **WebSocket** (кадр с изображением в КАУС) и
**CAN** (обнаружения на шину изделия по J1939). Modbus и прочие добавляются
новым модулем без изменения остального кода.

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
  clock.h            now_ms / mono_ms — системное и монотонное время
  config.h           FGatewayConfig / FWsConfig / FCanConfig + json
  ws-client.h        UWebSocketClient (адаптирован из media-center)
  transport.h        ITransport + UWsTransport
  message.h          FFrameMessage / FDetection (семантическая модель)
  frame-sink.h       IFrameSink + FSubmitResult (ingress → ядро)
  codec.h            ICodec + UCodecRegistry (версии протокола)
  frame-codec-v1.h   UFrameCodecV1
  stats.h            UStats — счётчики + кольцо последних сообщений
  taxonomy.h         UTaxonomy — общая таблица соответствий (имена → id)
  module.h           IModule — контракт одного канала доставки
  ws-module.h        UWsModule — доставка по WebSocket + heartbeat
  can-bus.h          ICanBus / ACanBus / USocketCanBus / USlcanBus + FCanFrame
  can-codec.h        J1939: сборка/разбор id, кодеки сообщений
  can-module.h       UCanModule — приём времени и GPS, выдача обнаружений
  integration.h      IIntegration — контракт конфигурации (набор модулей)
  rsm2000-integration.h  URsm2000Integration — РСМ-2000 (WebSocket + CAN)
  timesource.h       UTimeSource — время + GPS для остальных сервисов
  http-server.h      URouter / UHttpSession / UListener (REST, из media-center)
  grpc-ingress.h     UGrpcIngress — gRPC-сервер приёма кадров
  gateway.h          UGateway — оркестратор
src/
  frame-codec-v1.cpp       раскладка байт протокола v1
  taxonomy.cpp             правила разрешения + значения по умолчанию
  ws-module.cpp            кодирование + WS + heartbeat + stats
  can-bus.cpp              SocketCAN (raw-сокет) и slcan (serial port)
  can-codec.cpp            id J1939, координаты, дата/время, нагрузка
  can-module.cpp           приём от Садко, выдача по таймеру, stats
  rsm2000-integration.cpp  набор модулей РСМ-2000, сведение ответов
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
    --ws-host 192.168.1.50 --ws-port 8080 --ws-target /ws/frames --heartbeat 5 \
    --can-mode socketcan --can-iface can0 --can-src 0x71 --can-peer 0x61
```

Режим slcan (USB-адаптер на serial port), внешний `slcand` не нужен:

```
./message-gateway --can-mode slcan --can-device /dev/ttyUSB0 --can-bitrate 250000
```

Все параметры опциональны; дальше всё настраивается в рантайме через REST.
WebSocket-клиент к КАУС переподключается бесконечно (каждые 10 с), шина — каждые
5 с, даже если попытки неуспешны.

Флаги CAN: `--can-mode` (`socketcan`/`slcan`), `--can-iface`, `--can-device`,
`--can-bitrate`, `--can-src` (наш адрес), `--can-peer` (адрес Садко),
`--can-enabled 0`. Адреса принимают и `0x71`, и `113`.

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
подряд, получая `FrameReply` на каждый. Кадр раздаётся всем модулям активной
конфигурации, их ответы сводятся в один:
- взял хотя бы один модуль → `accepted:true, transport:"websocket+can",
  wire_size:...` (сумма по взявшим);
- не взял никто → `accepted:false`, в `error` причины по модулям через `;`,
  напр. `websocket: websocket not connected; can: can bus not connected`
  (кадры не буферизуются, чтобы очередь не росла);
- все модули не знают версию → `accepted:false,
  error:"unsupported ... (supported: 1)"`, поток не рвётся.

Кодек v1 (модуль WebSocket) собирает wire-кадр протокола: `[uint32 BE длина JSON]
[JSON-заголовок][image bytes]`, шлёт бинарным WS-фреймом. При простое канала шлюз
сам шлёт heartbeat каждые `heartbeat_sec` секунд. Модуль CAN версию протокола
изображения не смотрит: у него свой кодек и своя раскладка (см. ниже).

## Интеграции (конфигурации) и модули

Два уровня. **Интеграция** (`IIntegration`, [integration.h](include/gateway/integration.h)) —
конфигурация целиком; активна одновременно одна, выбор по REST
(`POST /integrations/select`). **Модуль** (`IModule`, [module.h](include/gateway/module.h)) —
один канал доставки внутри неё: свой транспорт, настройки, соединение и
статистика.

Сейчас реализована одна интеграция — **РСМ-2000** с двумя модулями:

| Модуль | Что делает |
|--------|------------|
| `websocket` | кадр (изображение + обнаружения) в КАУС по протоколу v1 + heartbeat |
| `can` | обнаружения на шину изделия (J1939) + приём времени и GPS от Садко |

Кадр из ingress уходит в **оба** модуля: это независимые каналы, молчание одного
не мешает другому. Ответ ingress'у сводится так: взял хотя бы один — `accepted`.

Новый канал = новая реализация `IModule` и `push_back` в конструкторе интеграции;
новая конфигурация = новая реализация `IIntegration` и `push_back` в
`setup_integrations()`. Ядро не меняется. Страница КРСПС рисует каждый модуль
отдельным разделом в левом столбце.

## Таблица соответствий

Нейросеть оперирует **именами**: класс (`cls`, напр. `person`) и суперкласс
(`scls`, напр. `human`). Протоколы стороны заказчика требуют **числа**: тип
обнаружения 1–8, класс опасности 1–4, номер камеры 1–2. Связь между ними задаёт
`UTaxonomy` ([taxonomy.h](include/gateway/taxonomy.h)) — **одна таблица на весь
шлюз**, общая для всех модулей всех конфигураций, а не настройка внутри CAN.
Настраивается по REST (`/taxonomy`) и на странице КРСПС.

Разрешение по приоритету:

1. правило **класса** (`cls`) — перекрывает суперкласс, но только заданными
   полями: можно уточнить классу лишь опасность, а тип оставить от группы;
2. правило **суперкласса** (`scls`) — правило для всей группы;
3. **значения по умолчанию** (`defaults`, из коробки тип 8, опасность 1).

`type`/`danger` равные `0` означают «не задано» — поле берётся с уровня ниже.
Реальные имена классов зависят от конфига модели, поэтому список классов из
коробки пуст, а суперклассы заполнены типовыми (`human`, `animal`, …).

## Модуль CAN

Шина за интерфейсом `ICanBus` ([can-bus.h](include/gateway/can-bus.h)), две
реализации, режим переключается настройкой `mode`:

| Режим | Чем является | Настройки |
|-------|--------------|-----------|
| `socketcan` | raw-сокет Linux на интерфейсе (штатный путь) | `iface` (`can0`) |
| `slcan` | USB-адаптер прямо на serial port, ASCII-протокол Lawicel | `device`, `bitrate` |

В режиме `socketcan` скорость шины задаётся **снаружи** — сокет её не выставляет:

```
ip link set can0 up type can bitrate 250000
```

В режиме `slcan` шлюз сам открывает порт (115200 8N1) и гоняет `C` → `S<n>` → `O`;
скорость берётся из `bitrate` (допустимы значения ряда S0..S8: 10000…1000000).
Внешний `slcand` при этом не нужен. Шина переподключается бесконечно (каждые 5 с).

### Передача: обнаружения (наше сообщение)

Приоритет `0`, PGN `0xEF00`, SA `0x71` → 29-битный id **`0x00EF0071`**. Кадр
уходит **строго по таймеру** раз в `tx_period_ms` (по умолчанию 100 мс)
**независимо от gRPC**: данные от media-center только обновляют нагрузку. Так
период на шине ровный и не зависит от частоты работы нейросети.

| Байт | Значение |
|------|----------|
| 1 | количество обнаружений |
| 2 | тип обнаружения (у обнаружения с наивысшим классом опасности) |
| 3 | класс опасности |
| 4 | id камеры |

Протокол задаёт 4 значащих байта, но J1939 требует в кадре все 8, поэтому по
умолчанию `tx_dlc = 8`, а хвост заполняется `0xFF` («значение недоступно»). Если
приёмник ждёт ровно 4 — поставьте `tx_dlc = 4`.

Если поток кадров от media-center встал, нагрузка живёт `payload_ttl_ms`
(по умолчанию 1 с), дальше на шину уходят нули: держать последнее
«человек, критическая опасность» — значит показывать тревогу, которой уже нет.

### Приём: время и GPS (сообщения Садко)

Слушаются сообщения устройства с адресом `peer_addr` (`0x61`), период 0,5 с:

| Сообщение | id | Что несёт |
|-----------|-----|-----------|
| координаты | `0x18FF0061` (PGN `0xFF00`) | широта/долгота: градусы, минуты (биты 1–6), знак (биты 7–8), секунды ×1000 (uint16 LE) |
| дата и время | `0x18FF0161` (PGN `0xFF01`) | год/месяц/день/час/минута/секунда UTC + путевая скорость (uint16 LE, 0,01 м/с) |

Принятое уходит в `UTimeSource`, откуда время и GPS забирают остальные сервисы
(REST `/time`, gRPC `GetTime`). Пока по шине ничего не пришло, отдаются часы
сервиса и заглушка координат (`source.time = "server"`).

**Время от шины используется исключительно**, но хранится не «как есть»: оно
приходит с точностью до секунды раз в 0,5 с, и между сообщениями стояло бы на
месте — два кадра подряд получили бы одну метку. Поэтому запоминается момент
приёма по монотонным часам, а при выдаче добавляется натикавшее с тех пор:
время остаётся временем Садко, но идёт непрерывно. Системные часы контейнера
не трогаются (не нужен `CAP_SYS_TIME`).

Координаты считаются достоверными (`gps.valid`), только пока сообщения идут:
двухсекундная тишина при периоде 0,5 с — это уже потеря связи.

## REST API (настройка)

| Метод | Путь | Назначение |
|-------|------|------------|
| GET  | `/health` | статус сервиса, соединение с КАУС, id активной интеграции |
| GET  | `/integrations` | список конфигураций + активная |
| POST | `/integrations/select` | выбрать активную конфигурацию `{ "id": "rsm-2000" }` |
| GET  | `/status` | полный статус активной: соединение + счётчики + последние сообщения |
| GET  | `/config` | конфигурация активной интеграции |
| PUT  | `/config/websocket` | обновить host/port/target/enabled/heartbeat_sec и переподключиться |
| PUT  | `/config/can` | обновить mode/iface/device/bitrate/адреса/PGN/период и переподключить шину |
| POST | `/modules/connect` | поднять модуль: `{ "module": "can" }` |
| POST | `/modules/disconnect` | погасить модуль: `{ "module": "can" }` |
| GET  | `/taxonomy` | общая таблица соответствий + словари типов и классов опасности |
| PUT  | `/taxonomy` | обновить таблицу (секция заменяется целиком) |
| POST | `/ws/connect` | поднять активную интеграцию целиком (все модули) |
| POST | `/ws/disconnect` | погасить активную интеграцию целиком |
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
        "heartbeats": 142, "repeats": 0, "rejected": 3,
        "recent": [ { "seq": 12989, "id": 48213, "ts": 1718700000000, "ver": 1,
                      "detections": 3, "wire_size": 188416, "kind": "frame", "status": "sent" } ]
      }
    },
    {
      "id": "can", "title": "CAN", "transport": "can",
      "heartbeat_sec": 0, "protocol_versions": [],
      "connection": { "connected": true, "enabled": true, "url": "can0",
                      "mode": "socketcan", "iface": "can0",
                      "device": "/dev/ttyUSB0", "bitrate": 250000, "error": "" },
      "addressing": { "src_addr": 113, "dst_addr": 0, "peer_addr": 97,
                      "tx_pgn": 61184, "tx_priority": 0, "tx_dlc": 8,
                      "tx_period_ms": 100, "payload_ttl_ms": 1000,
                      "gps_pgn": 65280, "time_pgn": 65281,
                      "tx_id": "0x00EF0071", "gps_id": "0x18FF0061",
                      "time_id": "0x18FF0161",
                      "src_addr_hex": "0x71", "peer_addr_hex": "0x61" },
      "payload": { "count": 2, "type": 1, "danger": 4, "camera": 1,
                   "type_title": "Человек",
                   "danger_title": "Критическая опасность", "age_ms": 40 },
      "rx": { "gps": 1204, "time": 1204, "errors": 0, "other": 8, "last_error": "" },
      "stats": {
        "messages": 60219, "detections": 3219, "images": 0, "bytes": 481752,
        "heartbeats": 0, "repeats": 59102, "rejected": 0,
        "recent": [ { "seq": 1118, "id": 48213, "ts": 1718700000000, "ver": 0,
                      "detections": 2, "wire_size": 8, "kind": "frame", "status": "sent" } ]
      }
    }
  ]
}
```

У модуля CAN `messages` — это кадры, ушедшие на шину, а `repeats` — из них те,
что повторяли неизменившуюся нагрузку. В ленту `recent` повторы не кладутся:
на десяти кадрах в секунду она стала бы нечитаемой. Кадр gRPC, вытесненный
следующим за 100 мс, в ленте тоже не появится — он на шину не попадал.

`/integrations` отдаёт список конфигураций для выбора (карточками): каждый элемент —
`{ id, title, description, connected, modules:[{ id, title, transport }] }`.

### PUT /config/websocket

Частичное обновление, тело JSON:

```json
{ "host": "192.168.1.50", "port": "8080", "target": "/ws/frames", "enabled": true, "heartbeat_sec": 5 }
```

### PUT /config/can

Частичное обновление, тело JSON. Смена `mode`/`device`/`bitrate`/`iface`
переподнимает шину:

```json
{ "mode": "socketcan", "iface": "can0", "enabled": true,
  "src_addr": 113, "peer_addr": 97, "tx_pgn": 61184, "tx_priority": 0,
  "tx_period_ms": 100, "tx_dlc": 8, "payload_ttl_ms": 1000 }
```

### PUT /taxonomy

Присутствующая секция заменяется целиком, отсутствующая остаётся как была.
Заплата применяется только целиком: при ошибке в любом правиле таблица не
меняется вовсе, чтобы не остаться наполовину обновлённой.

```json
{
  "superclasses": [ { "key": "human", "title": "Человек", "type": 1, "danger": 4 } ],
  "classes":      [ { "key": "sleeper", "title": "Шпала", "type": 0, "danger": 3 } ],
  "cameras":      [ { "key": "cam-path", "title": "Камера пути", "id": 1 } ]
}
```

### GET /time

Время и GPS от Садко с шины CAN. Общая точка входа для остальных сервисов.
Пока по шине ничего не пришло — часы сервиса и заглушка координат
(`source.time = "server"`, `source.gps = "static"`).

```json
{
  "unix_ms": 1718700000000, "unix_s": 1718700000, "iso": "2024-06-18T08:00:00Z",
  "gps": { "lat": 55.7695, "lon": 37.6626, "alt": 0.0, "valid": true,
           "sats": 0, "speed": 1.0, "course": 0.0, "age_ms": 120 },
  "source": { "time": "can", "gps": "can" }
}
```

`alt`/`sats`/`course` нулевые: Садко их не передаёт. `age_ms` — сколько прошло с
последнего сообщения координат.

## Замечания

- ingress держим **семантическим**. Если начнёте гонять через шлюз уже собранные
  wire-кадры «как есть» — слой становится чистым проксированием, тогда дешевле
  слать из media-center напрямую.
- при отсутствии соединения кадры не буферизуются, чтобы очередь отправки не
  росла бесконтрольно.
