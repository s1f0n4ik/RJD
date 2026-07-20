// Модель данных страницы интеграции с АС КРСПС (сервис message-gateway).
// Совпадает с JSON, который отдают REST-ручки шлюза (/api/gateway/*).
//
// Модель: конфигурация задаёт набор модулей (WebSocket, позже CAN, Modbus) и их
// настройки по умолчанию. Модуль — это канал доставки со своими настройками,
// состоянием подключения и статистикой.

export interface GwGpsFix {
  lat: number;
  lon: number;
  alt: number;
  valid: boolean;
  sats: number;
  speed: number;
  course: number;
  // Сколько прошло с последнего сообщения координат по CAN. Нет поля — источник
  // не CAN (шина молчит, отдаётся заглушка).
  age_ms?: number;
}

export interface GwTime {
  unix_ms: number;
  unix_s: number;
  iso: string;
  gps: GwGpsFix;
  source: { time: string; gps: string };
}

// Соединение модуля. url есть у любого модуля («куда подключён»), остальные поля
// зависят от транспорта: host/port/target — у WebSocket, mode/iface/device — у CAN.
export interface GwConnection {
  connected: boolean;
  enabled: boolean;
  url: string;
  host?: string;
  port?: string;
  target?: string;
  mode?: 'socketcan' | 'slcan';
  iface?: string;
  device?: string;
  bitrate?: number;
  error?: string;
  // WebSocket: идёт ли переподключение после сбоя. Со связью error пуст, статус
  // зелёный; при сбое error несёт причину, статус красный.
  retrying?: boolean;
}

// Одно сообщение на шине. Состав полей задан протоколом и не редактируется —
// настраивается только адрес, из которого собирается 29-битный id, и разбор
// (или отправка) сообщения целиком.
export interface GwCanMessage {
  key: 'tx_detections' | 'rx_gps' | 'rx_time';
  title: string;
  dir: 'tx' | 'rx';
  priority: number;
  pgn: number;
  addr: number;
  dst_addr: number;
  enabled: boolean;
  id: string;        // готовый 29-битный id, напр. "0x00EF0071"
  pgn_hex: string;
  addr_hex: string;
}

// Параметры выдачи кадра обнаружений.
export interface GwCanTx {
  continuous: boolean;   // слать по таймеру, а не только на новые обнаружения
  period_ms: number;
  dlc: number;
  ttl_enabled: boolean;  // ограничивать ли жизнь нагрузки по времени
  payload_ttl_ms: number;
}

// Вклад одной камеры в общую нагрузку.
export interface GwCanPayloadCamera {
  key: string;       // camera_id от media-center
  bit: number;       // 0 — камеры нет в таблице соответствий
  count: number;
  active: boolean;
  age_ms: number;    // -1 — кадров от этой камеры ещё не было
}

// Нагрузка, которая прямо сейчас уходит на шину.
export interface GwCanPayload {
  count: number;
  type: number;
  danger: number;
  camera_mask: number;
  camera_bits: string;   // поднятые биты как "1, 2"
  type_title: string;
  danger_title: string;
  cameras: GwCanPayloadCamera[];
  unmapped_cameras: number;   // кадры с камерой не из таблицы
  passthrough_frames: number; // кадры из конфигураций без таблицы
}

// Текущее состояние одного типа сообщения — сводка над лентой.
export interface GwCanSummary {
  key: string;
  title: string;
  dir: 'tx' | 'rx';
  enabled: boolean;
  id: string;
  count: number;
  errors: number;
  data: string;      // байты как "02 01 04 01 FF FF FF FF"
  note: string;      // расшифровка
  age_ms: number;    // -1 — кадров этого типа ещё не было
}

// Запись ленты: каждый кадр шины с полным id и байтами.
export interface GwCanLogRecord {
  seq: number;
  ts: number;
  dir: 'tx' | 'rx';
  id: string;
  data: string;
  note: string;
  error?: string;
}

// Устройства, которые сервис видит на машине.
export interface GwDevices {
  can: Array<{ name: string; up: boolean; kind: 'can' | 'vcan' }>;
  serial: Array<{ name: string }>;
}

export type GwRecordKind = 'frame' | 'heartbeat';
export type GwRecordStatus = 'sent' | 'rejected';

export interface GwMessageRecord {
  seq: number;
  id: number;
  ts: number;
  ver: number;
  detections: number;
  wire_size: number;
  kind: GwRecordKind;
  status: GwRecordStatus;
  error?: string;
}

export interface GwStats {
  messages: number;
  detections: number;
  images: number;
  bytes: number;
  heartbeats: number;
  // Повторные выдачи той же нагрузки (CAN шлёт кадр каждые 100 мс).
  repeats: number;
  rejected: number;
  recent: GwMessageRecord[];
}

// Модуль доставки внутри активной конфигурации. messages/tx/payload/summaries/log
// есть только у CAN — страница рисует их, когда transport === 'can'.
export interface GwModule {
  id: string;            // "websocket" | "can"
  title: string;
  transport: string;     // "websocket" | "can" | "modbus"
  heartbeat_sec: number;
  heartbeat_enabled?: boolean;  // WebSocket: слать ли служебный heartbeat
  protocol_versions: number[];
  connection: GwConnection;
  stats: GwStats;
  messages?: GwCanMessage[];
  tx?: GwCanTx;
  payload?: GwCanPayload;
  summaries?: GwCanSummary[];
  log?: GwCanLogRecord[];
  rx_other?: number;
}

// Полный снимок активной конфигурации со всеми её модулями (/status, /config).
export interface GwStatus {
  id: string;
  title: string;
  description: string;
  modules: GwModule[];
}

// Краткое описание модуля для карточки конфигурации.
export interface GwModuleSummary {
  id: string;
  title: string;
  transport: string;
}

export interface GwIntegrationItem {
  id: string;
  title: string;
  description: string;
  connected: boolean;
  modules: GwModuleSummary[];
}

export interface GwIntegrations {
  active: string;
  items: GwIntegrationItem[];
}

// Частичное обновление настроек WebSocket-модуля активной конфигурации.
export interface GwWsConfigPatch {
  host?: string;
  port?: string;
  target?: string;
  enabled?: boolean;
  heartbeat_sec?: number;
  heartbeat_enabled?: boolean;
}

// Адрес сообщения в заплате настроек.
export interface GwCanMessagePatch {
  priority?: number;
  pgn?: number;
  addr?: number;
  dst_addr?: number;
  enabled?: boolean;
}

// Частичное обновление настроек CAN-модуля активной конфигурации.
export interface GwCanConfigPatch {
  mode?: 'socketcan' | 'slcan';
  iface?: string;
  device?: string;
  bitrate?: number;
  enabled?: boolean;
  tx_continuous?: boolean;
  tx_period_ms?: number;
  tx_dlc?: number;
  payload_ttl_enabled?: boolean;
  payload_ttl_ms?: number;
  tx_detections?: GwCanMessagePatch;
  rx_gps?: GwCanMessagePatch;
  rx_time?: GwCanMessagePatch;
}

// ---------------------------------------------------------------- таблица
// Общая таблица соответствий (/taxonomy): одна на весь шлюз, применяется всеми
// модулями. Нейросеть отдаёт имена классов, протоколы требуют числовые id —
// здесь задаётся связь между ними.

// Словарь протокола: тип обнаружения 1..8 либо класс опасности 1..4.
// Фиксирован на стороне шлюза, правке не подлежит.
export interface GwTaxonomyDictItem {
  id: number;
  title: string;
}

// Правило класса или суперкласса. type/danger === 0 — «не задано»: поле
// берётся с более общего уровня (класс -> суперкласс -> по умолчанию).
export interface GwTaxonomyRule {
  key: string;
  title: string;
  type: number;
  danger: number;
}

// Таблица одной конфигурации нейросети. Имена классов задаются конфигом модели
// и осмысленны только внутри своей конфигурации, поэтому таблица у каждой своя.
export interface GwTaxonomyConfig {
  id: string;      // config_id, каким его шлёт media-center
  title: string;
  classes: GwTaxonomyRule[];
  superclasses: GwTaxonomyRule[];
}

// Камера. Вне конфигураций: камера физическая, от модели не зависит.
export interface GwTaxonomyCamera {
  key: string;    // camera_id, каким его шлёт media-center
  title: string;
  bit: number;    // номер бита в байте камер, 1..8
  mask?: number;  // 1 << (bit - 1) — считает шлюз
}

export interface GwTaxonomy {
  types: GwTaxonomyDictItem[];
  dangers: GwTaxonomyDictItem[];
  configs: GwTaxonomyConfig[];
  cameras: GwTaxonomyCamera[];
  defaults: { type: number; danger: number };
}

// Секции заменяются целиком; отсутствующая остаётся как была.
export interface GwTaxonomyPatch {
  configs?: GwTaxonomyConfig[];
  cameras?: GwTaxonomyCamera[];
  defaults?: { type: number; danger: number };
}
