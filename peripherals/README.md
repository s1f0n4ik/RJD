# peripherals

Сервис дополнительных модулей РСМ 2000. Он входит в master-стек, получает
устройства активного профиля через `/config` и управляется общим переходом
профиля через `/runtime`.

Контракты первой версии:

- HTTP `8006`: `/health`, `/runtime`, `/config`, `/status`, `/devices`, `/values`;
- WebSocket `/ws/scans/{device_id}`;
- gRPC `50053`: `Describe`, `Subscribe`, `Events`, `Status`;
- опрос `FrameIngress.GetTime` шлюза без собственного хранения настроек.

Физические устройства регистрируются как драйверы. Последовательный порт
открывается только через `LineManager`, поэтому несколько адресов одной линии
опроса не конкурируют за tty.

Поддерживаемые драйверы:

- `pyrometer_board` - плата на четырёх входах, восемь регистров начиная с
  999; каналы назначаются через `pair_targets`;
- `kelvin` - Kelvin ИКС-485, блок состояния `0x0400..0x0403` и
  коэффициент излучения `0x1FFF`;
- `discrete` - пять регистров дискретного модуля, устойчивое значение 3
  публикуется как СТАРТ поездки;
- `lidar` - универсальный LiDAR с выбором протокола `auto`, `sick_cola_a`
  (SICK TiM/LMS по SOPAS TCP) или `lakibeam_udp`; старый kind `lakibeam`
  сохранён для совместимости.

Пример сущностей `peripheral` одного профиля:

```json
{
  "lidar-main": {
    "kind": "lidar",
    "name": "LiDAR",
    "protocol": "auto",
    "ip": "192.168.1.115",
    "tcp_port": 2111,
    "frequency_hz": 15
  },
  "pyrometer-board": {
    "kind": "pyrometer_board",
    "port": "/dev/ttyUSB0",
    "baudrate": 9600,
    "slave_id": 12,
    "start_register": 999,
    "pair_targets": ["air", "left_rail", "ballast", "right_rail"],
    "max_delta": 20
  },
  "trip-input": {
    "kind": "discrete",
    "port": "/dev/ttyUSB0",
    "baudrate": 9600,
    "slave_id": 11,
    "start_register": 999,
    "debounce_samples": 10
  },
  "kelvin-left": {
    "kind": "kelvin",
    "port": "/dev/ttyUSB0",
    "baudrate": 9600,
    "slave_id": 1,
    "object_target": "left_rail",
    "ambient_target": "none",
    "emissivity": 0.95
  }
}
```

Все три устройства используют один объект линии по имени порта. Несовместимые
физические параметры одного порта отклоняются при загрузке профиля. Таймауты,
повторы и паузы задаются для каждого участника отдельно.
