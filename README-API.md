# API приложения

Полный список ручек, которые использует веб-приложение, вместе с преобразованием
путей на nginx. Источники: [shit/frontend/nginx.conf](shit/frontend/nginx.conf),
клиенты фронта в [shit/frontend/src](shit/frontend/src),
[rest_server.cpp](media-center/src/main-server/rest_server.cpp),
роутеры FastAPI и [message-gateway/README.md](message-gateway/README.md).

Браузер ходит **только на свой origin, порт 80**. Всё остальное — внутренние
адреса, наружу не публикуются.

## Сервисы за nginx

| Upstream | Адрес | Что это |
|---|---|---|
| `backend` | `127.0.0.1:8000` | FastAPI: авторизация, сетки, статус, WS состояния ([shit/backend](shit/backend)) |
| `media_center` | `127.0.0.1:7777` | C++ ядро: камеры, линкер, нейронка ([media-center](media-center)) |
| `signaling` | `127.0.0.1:8765` | WebRTC-брокер ([server.py](media-center/server/server.py)) |
| `storage_service` | `127.0.0.1:8001` | записи, склейка, журнал обнаружений ([storage-service](storage-service)) |
| `camera_scanner` | `127.0.0.1:8002` | ONVIF-поиск камер ([scanner](scanner)) |
| `message_gateway` | `127.0.0.1:9090` | шлюз CAN/WebSocket ([message-gateway](message-gateway)) |

## Преобразование путей на nginx

Порядок в таблице — порядок разбора: точные совпадения (`=`) и регулярки
выигрывают у префиксов, поэтому общий `/api/` внизу забирает только остаток.

| Что просит браузер | Правило nginx | Куда уходит | Путь на сервисе |
|---|---|---|---|
| `/…` | `try_files` | — | статика SPA, `index.html` |
| `/auth/…` | префикс | backend | `/auth/…` без изменений |
| `/api/scan…` | `rewrite ^/api/scan(.*)$ /scan$1` | camera_scanner | `/scan…`, буферизация выключена (SSE) |
| `/api/cameras` | `=`, `rewrite ^ /camera` | media_center | `GET /camera` |
| `/api/streams` | `=`, `rewrite ^ /streams` | media_center | `GET /streams` |
| `/api/camera` | `=`, `rewrite ^ /camera` | media_center | `/camera` (GET/POST/PATCH/DELETE) |
| `/api/camera/{id}` | `~ ^/api/camera/(.+)$` → `/camera?id=$1` | media_center | `/camera?id={id}` |
| `/linker/…` | префикс, без rewrite | media_center | `/linker/…` |
| `/neural/…` | префикс, без rewrite | media_center | `/neural/…` |
| `/api/recordings…` | префикс, без rewrite | storage_service | `/api/recordings…`, `proxy_read_timeout 600s` |
| `/api/recordings/jobs/{id}/progress` | регулярка, upgrade | storage_service | тот же путь, WebSocket, таймаут 3600s |
| `/api/journal…` | префикс, без rewrite | storage_service | `/api/journal…` |
| `/api/gateway/…` | `rewrite ^/api/gateway/(.*)$ /$1` | message_gateway | префикс срезается: `/api/gateway/status` → `/status` |
| `/api/…` (всё остальное) | префикс | backend | `/api/…` без изменений |
| `/ws` | `=`, upgrade | backend | WebSocket `/ws`, таймаут 3600s |
| `/signaling/…` | `rewrite ^/signaling/(.*)$ /$1`, upgrade | signaling | префикс срезается: `/signaling/client/cam_1` → `/client/cam_1` |

Общее для всех прокси — [snippets/proxy-common.conf](snippets/proxy-common.conf):
`Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, HTTP/1.1.
Лимит тела запроса — 50 МБ (`client_max_body_size`), под загрузку картинок
конфигуратора и моделей `.glb`.

---

## FastAPI — авторизация, сетки, статус (порт 8000)

Роутеры: [auth.py](shit/backend/app/routers/auth.py),
[layouts.py](shit/backend/app/routers/layouts.py),
[status.py](shit/backend/app/routers/status.py),
[loaders.py](shit/backend/app/routers/loaders.py).

| Метод | Путь через nginx | Назначение | Кто дёргает |
|---|---|---|---|
| POST | `/auth/login` | логин, отдаёт `access_token`, `role`, `username` | [Login.tsx:31](shit/frontend/src/components/Login.tsx#L31), [App.tsx:150](shit/frontend/src/App.tsx#L150) — там же проверка пароля админа |
| GET | `/auth/me` | текущий пользователь по токену | сервером отдаётся, фронтом не используется |

Учётные записи захардкожены в `USERS_DB`
([auth.py:16](shit/backend/app/services/auth.py#L16)): `admin` (роль `admin`)
и `user` (роль `viewer`). Токен живёт 8 часов.

**Гейт только фронтовый.** Ни один роутер, кроме `/auth/*`, не имеет
`Depends(get_current_user)`; `require_admin`
([auth.py:83](shit/backend/app/services/auth.py#L83)) объявлен и не используется.
Фронт не отправляет `Authorization` ни в одном запросе. Media-center (7777),
storage-service (8001), scanner (8002), message-gateway (9090) и signaling (8765)
не проверяют ничего. Любой вариант сборки защищает только от случайного
пользователя, но не от прямых запросов к API.
| GET | `/api/layouts` | список сохранённых сеток | [Layouts.ts:37](shit/frontend/src/hooks/Layouts.ts#L37) |
| POST | `/api/layouts` | создать/обновить сетку | [Layouts.ts:48](shit/frontend/src/hooks/Layouts.ts#L48) |
| DELETE | `/api/layouts/{name}` | удалить сетку | [Layouts.ts:62](shit/frontend/src/hooks/Layouts.ts#L62) |
| WS | `/ws` | состояние системы: `initial_state` / `status_update` | [websocket.ts:16](shit/frontend/src/services/websocket.ts#L16) |

Зарегистрированы, но фронтом не используются: `GET /api/status/system`,
`GET /api/status/endpoints`, весь блок `/api/loaders` и `/api/loader/…`
(включая `/loader/{name}/start`, `/stop`, `/validate-matrix`),
`GET /neural_{id}` из [streams.py](shit/backend/app/routers/streams.py)
(на него ссылается только словарь `ENDPOINT_MAP` в
[constants.ts:19](shit/frontend/src/utils/constants.ts#L19)),
`GET /` и `GET /health`. Роутер записей в бэкенде отключён — записи целиком
переехали в storage-service.

## Media Center — камеры (порт 7777)

Ответы обёрнуты в `{ data, meta, error }`; клиент разворачивает их и кидает
`MediaCenterError` при непустом `error` ([api.ts](shit/frontend/src/services/api.ts)).

| Метод | Путь через nginx | Путь в C++ | Назначение |
|---|---|---|---|
| GET | `/api/cameras` | `/camera` | камеры + виртуальные потоки одним ответом |
| GET | `/api/camera` | `/camera` | то же; используется линкером и страницей нейронки |
| GET | `/api/streams` | `/streams` | только виртуальные потоки, без списка камер |
| POST | `/api/camera` | `/camera` | создать камеру |
| PATCH | `/api/camera/{id}` | `/camera?id={id}` | правка `meta` и `critical` (пароль — только при реальной смене) |
| DELETE | `/api/camera/{id}` | `/camera?id={id}` | удалить камеру |

Дёргают: [api.ts](shit/frontend/src/services/api.ts),
[cameras.ts](shit/frontend/src/features/birdview/api/cameras.ts),
[linker.ts:324](shit/frontend/src/features/birdview/api/linker.ts#L324) (фильтр `type === 3`),
[neural/api/client.ts:142](shit/frontend/src/features/neural/api/client.ts#L142),
[CameraSettings.tsx:208](shit/frontend/src/components/CameraSettings.tsx#L208).

## Media Center — линкер / birdview

Префикс `/linker/` проксируется как есть.
Клиент — [linker.ts](shit/frontend/src/features/birdview/api/linker.ts).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/linker/exports` | список конфигураций сшивки |
| POST | `/linker/exports` | сохранить конфигурацию (`multipart`: `config` + файлы `images`) — [conf-export.ts:194](shit/frontend/src/features/birdview/components/configurator/conf-export.ts#L194) |
| GET | `/linker/export?id=` | полная запись: канвас, места камер, подложки, габарит, поворот |
| DELETE | `/linker/export?id=` | удалить запись, карты и настройки |
| GET | `/linker/presets` | список пресетов — [LoadPresetModal.tsx:73](shit/frontend/src/features/birdview/components/configurator/LoadPresetModal.tsx#L73) |
| GET | `/linker/preset?key=` | один пресет |
| GET | `/linker/image?name=` | картинка-подложка конфигурации — [conf-import.ts:91](shit/frontend/src/features/birdview/components/configurator/conf-import.ts#L91) |
| GET | `/linker/state` | сохранённые привязки и параметры по всем конфигурациям |
| POST | `/linker/state` | сохранить привязки + `fps` / `stream_id` / `stream_name` / `rotation` |
| GET | `/linker/status` | что в эфире: `running`, `stream_id`, `view_mode`, `rotation`, размер кадра |
| POST | `/linker/start` | запустить вывод |
| POST | `/linker/stop` | остановить вывод |
| POST | `/linker/rotation` | поворот вывода (0/90/180/270), живой перезапускается сервером |
| POST | `/linker/view-mode` | переключение `top` ↔ `surround` |
| GET | `/linker/surround?id=` | настройки объёмного вида + печёные позы камер |
| POST | `/linker/surround` | частичный мёрж surround-блока |
| POST | `/linker/surround-camera` | ручная поза камеры места либо `reset` к PnP |
| GET | `/linker/top?id=` | настройки плоской сшивки, версии карт, рисунки |
| POST | `/linker/top` | частичный мёрж top-блока |
| POST | `/linker/top-version` | смена активной версии карт |
| POST | `/linker/recalc` | полный пересчёт из пресета (синхронный) |
| GET | `/linker/models` | библиотека моделей `.glb` |
| POST | `/linker/upload-model` | загрузка `.glb` (`multipart`, поле `model`) |

Есть на сервере, но фронтом не вызываются: `POST /linker/restart`,
`POST /linker/upload` (загрузка картинки отдельной ручкой — конфигуратор шлёт
их вместе с `POST /linker/exports`).

`GET /linker/status`, `GET /linker/surround`, `POST /linker/view-mode` дублируются
в плеере [SurroundWebRTCPlayer.tsx](shit/frontend/src/components/SurroundWebRTCPlayer.tsx).

## Media Center — нейронка

Префикс `/neural/` проксируется как есть. Ответы — сырой JSON либо `{ data }`,
клиенты терпят оба варианта. Клиенты:
[neural/api/client.ts](shit/frontend/src/features/neural/api/client.ts) (основной)
и хвост [services/api.ts:232-285](shit/frontend/src/services/api.ts#L232-L285)
(используется старым экраном настроек).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/neural/configurations` | список конфигураций |
| GET | `/neural/configurations?id=` | одна конфигурация целиком |
| POST | `/neural/configurations` | импорт: `{ mode: "merge" \| "replace", data }` |
| GET | `/neural/state` | активные дескрипторы |
| POST | `/neural/state` | задать состояние (тело — массив дескрипторов) |
| GET | `/neural/status` | рантайм-статус слотов |
| POST | `/neural/start` | запустить супервизор |
| POST | `/neural/stop` | остановить |
| POST | `/neural/restart` | перезапустить |
| GET | `/neural/classes?config_id=` | классы конфигурации |
| GET | `/neural/superclasses?config_id=` | суперклассы конфигурации |
| GET | `/neural/tracker-types` | доступные типы трекеров |
| GET | `/neural/event-types` | возможные события трека |
| GET | `/neural/system` | платформа и лимиты потоков |
| GET | `/neural/models` | список моделей |
| POST | `/neural/models?filename=*.rknn` | загрузка модели, тело — бинарь (`application/octet-stream`) |
| GET | `/neural/camera?camera_id=` | какая конфигурация обслуживает камеру — [NeuralWebRTCPlayer.tsx:73](shit/frontend/src/components/NeuralWebRTCPlayer.tsx#L73) |

`/neural/classes` и `/neural/superclasses` дополнительно нужны странице КРСПС:
она подставляет ключи в таблицу соответствий шлюза, чтобы не ловить опечатки.

## Storage Service — записи (порт 8001)

Роутер [recordings.py](storage-service/app/routers/recordings.py), путь
проксируется без изменений.

| Метод | Путь | Назначение | Кто дёргает |
|---|---|---|---|
| GET | `/api/recordings` | все записи по камерам | [RecordingsView.tsx:88](shit/frontend/src/components/RecordingsView.tsx#L88), [Recordings.tsx:38](shit/frontend/src/components/Recordings.tsx#L38) |
| GET | `/api/recordings/disk` | состояние диска: всего/занято/записи/лимит | [DiskUsage.tsx:46](shit/frontend/src/components/DiskUsage.tsx#L46) |
| GET | `/api/recordings/{camera}` | записи одной камеры | — |
| GET | `/api/recordings/stream/{camera}/{file}` | просмотр файла с Range | [RecordingsPlayer.tsx:121](shit/frontend/src/components/RecordingsPlayer.tsx#L121), [RecordingsTimeline.tsx:476](shit/frontend/src/components/RecordingsTimeline.tsx#L476) |
| GET | `/api/recordings/download/{camera}/{file}` | скачивание файла | [RecordingsFileList.tsx:121](shit/frontend/src/components/RecordingsFileList.tsx#L121), [Recordings.tsx:83](shit/frontend/src/components/Recordings.tsx#L83) |
| POST | `/api/recordings/merge` | склейка диапазона, отдаёт `job_id` | [RecordingsView.tsx:214](shit/frontend/src/components/RecordingsView.tsx#L214) |
| POST | `/api/recordings/archive` | архив за день или диапазон, отдаёт `job_id` | [RecordingsView.tsx:231](shit/frontend/src/components/RecordingsView.tsx#L231) |
| GET | `/api/recordings/jobs` | активные задачи — восстановление после reload | [MergeJobsContext.tsx:68](shit/frontend/src/contexts/MergeJobsContext.tsx#L68) |
| DELETE | `/api/recordings/jobs/{id}` | отменить/убрать задачу | [MergeJobsContext.tsx:145](shit/frontend/src/contexts/MergeJobsContext.tsx#L145) |
| GET | `/api/recordings/jobs/{id}/download` | результат задачи, после отдачи job чистится | [MergeJobsContext.tsx:134](shit/frontend/src/contexts/MergeJobsContext.tsx#L134) через [downloadWithProgress.ts](shit/frontend/src/utils/downloadWithProgress.ts) |
| WS | `/api/recordings/jobs/{id}/progress` | прогресс склейки, закрывается на `ready`/`failed` | [MergeJobsContext.tsx](shit/frontend/src/contexts/MergeJobsContext.tsx) |

`POST /api/recordings/path` (смена пути записей в рантайме) существует, но фронт
её не вызывает.

## Storage Service — журнал обнаружений

Роутер [journal.py](storage-service/app/routers/journal.py), клиент —
[journal.ts](shit/frontend/src/features/neural/api/journal.ts).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/journal/detections` | список; фильтры `t_from`, `t_to`, `verdict`, `camera_id`, `config_id`, `cids`, `bbox` + `order`, `limit` (≤500), `offset` |
| GET | `/api/journal/head` | лёгкий опрос: `{ max_id, total }` по тем же фильтрам — по нему решается, перезапрашивать ли список |
| GET | `/api/journal/detections/{id}` | одно обнаружение |
| PATCH | `/api/journal/detections/{id}/verdict` | вердикт оператора: `{ verdict, note }` |
| GET | `/api/journal/frame/{id}.jpg` | кадр обнаружения |
| GET | `/api/journal/map/style.json` | стиль MapLibre со своего origin (offline) |
| GET | `/api/journal/map/glyphs/{fontstack}/{range}.pbf` | глифы шрифтов — без них нет подписей |
| GET | `/api/journal/map/sprite/{name}` | спрайты стиля |
| GET | `/api/journal/tiles/{z}/{x}/{y}.pbf` | векторные тайлы из offline `.mbtiles` |

Три последних блока фронт не зовёт из кода — на них ссылается сам `style.json`,
запросы делает MapLibre.

## Camera Scanner (порт 8002)

Роутер [scan.py](scanner/app/routers/scan.py). nginx срезает `/api`:
`/api/scan/stream` → `/scan/stream`.

| Метод | Путь через nginx | Назначение |
|---|---|---|
| GET | `/api/scan/cameras` | быстрый ONVIF WS-Discovery, JSON. Параметры: `enrich`, `username`, `password`, `timeout`. Фронтом не используется |
| GET | `/api/scan/subnets` | локальные подсети /24: `[{prefix, address, iface}]`. Заполняет селектор «Где искать» |
| GET (SSE) | `/api/scan/stream` | ONVIF + порт-скан батчами. Параметры: `subnet` (пусто — **все** локальные подсети), `from`, `to`, `onvif_timeout` |

SSE читается через `EventSource` в
[CameraSettings.tsx](shit/frontend/src/components/CameraSettings.tsx).
Этапы событий: `onvif_start` → `onvif_done` → `ports_start` → `ports_progress`
(многократно) → `done`. Для этого location в nginx выключена буферизация.

### Выбор подсети на многосетевой машине

Раньше при пустом `subnet` подсеть угадывалась UDP-сокетом на `8.8.8.8`: ОС
выбирала адрес по **дефолтному маршруту**. На машине с двумя адресами это
всегда внешняя сеть, а камерная не сканировалась никогда. Функция удалена;
теперь адреса перечисляются через `psutil.net_if_addrs()`
([port_scan.py](scanner/app/services/port_scan.py)) — только так видны **все**
адреса интерфейса, а не первый.

Отбрасываются loopback, link-local и интерфейсы с `isup == False` — иначе в
список попадают docker-мосты, чьи подсети никуда не ведут. Фильтр по свойствам,
а не по именам, поэтому переименование интерфейсов его не ломает.

При нескольких подсетях счётчик сквозной: `ports_start` приходит один раз с
суммарным `total` и списком `subnets`, а каждое `ports_progress` несёт поле
`subnet` для подписи. Прогресс-бар едет от 0 до 100 ровно один раз.

ONVIF-probe рассылается с **каждого** локального адреса через `IP_MULTICAST_IF`
([onvif_discovery.py](scanner/app/services/onvif_discovery.py)); без этого ядро
брало один адрес по дефолтному маршруту и камеры остальных сетей probe не
получали. Ответы фильтруются по выбранной подсети, чтобы выбор в UI означал одно
и то же для обоих этапов.

Порт-скан устроен как «префикс + 1..254», то есть **всегда работает как /24**
независимо от реальной маски: для /16 просканируется только один октет.

## Message Gateway — КРСПС (порт 9090)

nginx срезает префикс: `/api/gateway/status` → `/status`. Клиент —
[krsps/api/client.ts](shit/frontend/src/features/krsps/api/client.ts).
Полное описание тел — [message-gateway/README.md](message-gateway/README.md).

| Метод | Путь через nginx | Путь в шлюзе | Назначение |
|---|---|---|---|
| GET | `/api/gateway/integrations` | `/integrations` | список конфигураций + активная |
| POST | `/api/gateway/integrations/select` | `/integrations/select` | выбрать активную: `{ id }` |
| GET | `/api/gateway/status` | `/status` | полный статус: модули, соединения, счётчики, лента шины |
| PUT | `/api/gateway/config/websocket` | `/config/websocket` | host/port/target/enabled/heartbeat_sec + переподключение |
| PUT | `/api/gateway/config/can` | `/config/can` | режим шины, адреса сообщений, период, DLC |
| POST | `/api/gateway/modules/connect` | `/modules/connect` | поднять модуль: `{ module }` |
| POST | `/api/gateway/modules/disconnect` | `/modules/disconnect` | погасить модуль |
| GET | `/api/gateway/taxonomy` | `/taxonomy` | таблица соответствий + словари типов и опасностей |
| PUT | `/api/gateway/taxonomy` | `/taxonomy` | обновить таблицу (секция заменяется целиком) |
| GET | `/api/gateway/devices` | `/devices` | CAN-интерфейсы и serial-порты машины |
| GET | `/api/gateway/time` | `/time` | время и GPS от Садко |

Шлюз отдаёт JSON **без обёртки** `{ data }`; ошибка приходит как `{ error }`.

Есть у шлюза, но страницей не используются: `/health`, `/config`,
`/ws/connect`, `/ws/disconnect`, `/ws/status`, `/protocol/versions`, `/gps`.

## WebRTC signaling (порт 8765)

nginx срезает `/signaling/`, дальше брокер разбирает путь как `/<роль>/<id>`
([server.py:509](media-center/server/server.py#L509)). Роли: `camera`, `client`,
`calibrator`, `cal-client`. Браузер всегда клиентская половина пары.

| Что открывает браузер | Путь в брокере | Назначение |
|---|---|---|
| `/signaling/client/{cameraId}` | `/client/{cameraId}` | WebRTC-сессия к камере или виртуальному потоку |
| `/signaling/cal-client/server` | `/cal-client/server` | основной сокет калибратора birdview: 18 типов сообщений, бинарные кадры `[uint32 BE длина JSON][JSON][JPEG]` |

`/signaling/client/{id}` используют
[WebRTCPlayerFactory.tsx:15](shit/frontend/src/components/WebRTCPlayerFactory.tsx#L15),
[Observation.tsx](shit/frontend/src/components/Observation.tsx),
[KioskView.tsx:302](shit/frontend/src/components/KioskView.tsx#L302),
[CameraSettings.tsx:1212](shit/frontend/src/components/CameraSettings.tsx#L1212) (проба камеры),
[StreamView.tsx](shit/frontend/src/features/birdview/components/linker/StreamView.tsx),
[LinkerScreen.tsx:621](shit/frontend/src/features/birdview/components/linker/LinkerScreen.tsx#L621),
[ProjectionScreen.tsx:673](shit/frontend/src/features/birdview/components/projection/ProjectionScreen.tsx#L673),
[CalibrationViewer.tsx:72](shit/frontend/src/features/birdview/components/calibration/CalibrationViewer.tsx#L72).
Калибраторский сокет поднимается один на страницу в
[BirdviewApp.tsx:70](shit/frontend/src/features/birdview/components/BirdviewApp.tsx#L70),
переподключения нет намеренно — слот у калибратора один.

## Сводка WebSocket и потоковых ручек

| Путь | Транспорт | Кто держит |
|---|---|---|
| `/ws` | WebSocket → FastAPI | состояние системы, подписка `{ type: "subscribe" }` |
| `/signaling/client/{id}` | WebSocket → брокер | WebRTC-сигналинг видео |
| `/signaling/cal-client/server` | WebSocket → брокер | калибратор birdview |
| `/api/recordings/jobs/{id}/progress` | WebSocket → storage-service | прогресс склейки/архивации |
| `/api/scan/stream` | SSE → scanner | поиск камер в сети |

## Мимо nginx

Наружу не публикуется, браузер этого не видит:

- **gRPC `localhost:50051`** — ingress кадров media-center → message-gateway
  (`FrameIngress.StreamFrames` / `SendFrame`), контракт
  [frame-ingress.proto](message-gateway/proto/frame-ingress.proto).
- **HTTP `0.0.0.0:8766`** — `GET /destroy/{camera|calibrator}/{id}` у брокера,
  принудительный разрыв пары ([server.py:428](media-center/server/server.py#L428)).
- **WebSocket-клиент шлюза к КАУС** — исходящее соединение на сторонний хост,
  цель настраивается через `PUT /api/gateway/config/websocket`.
- **CAN-шина** — J1939 через SocketCAN или slcan, настройки через
  `PUT /api/gateway/config/can`.

## Смена адреса бэкенда в dev-режиме

Два клиента умеют бить в чужой хост мимо своего origin, в проде оба пустые:

- `API_HOST` в [neural/api/client.ts:25](shit/frontend/src/features/neural/api/client.ts#L25) —
  ручки нейронки и журнала;
- `API_HOST` в [krsps/api/client.ts:17](shit/frontend/src/features/krsps/api/client.ts#L17) —
  ручки шлюза.

Остальные клиенты всегда ходят на относительные пути.

## Два варианта сборки фронта

Различие задаётся флагом `VITE_FULL_AUTH`, который читается один раз в
[utils/auth.ts](shit/frontend/src/utils/auth.ts) и вычисляется на этапе сборки.
Ветка, не подходящая под режим, вырезается минификатором из бандла.

```
npm run build          # открытый просмотр: логин только на /app
npm run build:secure   # логин на все маршруты, включая / и /kiosk
```

Значение берётся из `.env` (`false`) и переопределяется в `.env.secure` (`true`).
В Docker — через `--build-arg FULL_AUTH=true`
([Dockerfile:16](shit/frontend/Dockerfile#L16)); `docker-compose.yml` не
параметризован и всегда собирает открытый вариант.

| | `build` | `build:secure` |
|---|---|---|
| `/` — [Landing.tsx](shit/frontend/src/components/Landing.tsx) | открыт | логин |
| `/kiosk` — [KioskView.tsx](shit/frontend/src/components/KioskView.tsx) | открыт | логин |
| `/app*` | логин | логин |
| viewer → вкладка «Камеры» и `/app/{neural,krsps,birdview}` | отказ + ввод пароля админа | отказ |
| переход в киоск с экрана логина | есть | скрыт |

Гейт по ролям: `ADMIN_TABS` и `ADMIN_ROUTES`
([App.tsx:31](shit/frontend/src/App.tsx#L31)). Временное повышение прав хранится
в состоянии `elevated` ключами вида `tab:1` / `route:neural` и живёт до
перезагрузки страницы. В защищённой сборке эскалации нет — решает роль из токена.

Токен читается из `localStorage` при загрузке страницы, его `exp` проверяется
там же ([utils/auth.ts](shit/frontend/src/utils/auth.ts)). Подпись не
проверяется, повторной проверки по таймеру нет: уже открытая вкладка работает,
пока её не перезагрузят. В защищённой сборке это значит, что киоск на видеостене
потребует входа через 8 часов после перезагрузки машины.
