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
}

// Адресация J1939 модуля CAN.
export interface GwCanAddressing {
  src_addr: number;
  dst_addr: number;
  peer_addr: number;
  tx_pgn: number;
  tx_priority: number;
  tx_dlc: number;
  tx_period_ms: number;
  payload_ttl_ms: number;
  gps_pgn: number;
  time_pgn: number;
  tx_id: string;         // готовый 29-битный id, напр. "0x00EF0071"
  gps_id: string;
  time_id: string;
  src_addr_hex: string;
  peer_addr_hex: string;
}

// Нагрузка, которая прямо сейчас уходит на шину.
export interface GwCanPayload {
  count: number;
  type: number;
  danger: number;
  camera: number;
  type_title: string;
  danger_title: string;
  age_ms: number;        // -1 — кадров от media-center ещё не было
}

// Что слышно от стороннего устройства (Садко).
export interface GwCanRx {
  gps: number;
  time: number;
  errors: number;
  other: number;
  last_error: string;
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

// Модуль доставки внутри активной конфигурации. addressing/payload/rx есть
// только у CAN — страница рисует их, когда transport === 'can'.
export interface GwModule {
  id: string;            // "websocket" | "can"
  title: string;
  transport: string;     // "websocket" | "can" | "modbus"
  heartbeat_sec: number;
  protocol_versions: number[];
  connection: GwConnection;
  stats: GwStats;
  addressing?: GwCanAddressing;
  payload?: GwCanPayload;
  rx?: GwCanRx;
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
}

// Частичное обновление настроек CAN-модуля активной конфигурации.
export interface GwCanConfigPatch {
  mode?: 'socketcan' | 'slcan';
  iface?: string;
  device?: string;
  bitrate?: number;
  enabled?: boolean;
  src_addr?: number;
  dst_addr?: number;
  peer_addr?: number;
  tx_pgn?: number;
  tx_priority?: number;
  tx_period_ms?: number;
  tx_dlc?: number;
  payload_ttl_ms?: number;
  gps_pgn?: number;
  time_pgn?: number;
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

export interface GwTaxonomyCamera {
  key: string;    // camera_id, каким его шлёт media-center
  title: string;
  id: number;     // номер камеры в протоколе: 1 или 2
}

export interface GwTaxonomy {
  types: GwTaxonomyDictItem[];
  dangers: GwTaxonomyDictItem[];
  classes: GwTaxonomyRule[];
  superclasses: GwTaxonomyRule[];
  cameras: GwTaxonomyCamera[];
  defaults: { type: number; danger: number };
}

// Секции заменяются целиком; отсутствующая остаётся как была.
export interface GwTaxonomyPatch {
  classes?: GwTaxonomyRule[];
  superclasses?: GwTaxonomyRule[];
  cameras?: GwTaxonomyCamera[];
  defaults?: { type: number; danger: number };
}
