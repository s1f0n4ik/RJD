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
}

export interface GwTime {
  unix_ms: number;
  unix_s: number;
  iso: string;
  gps: GwGpsFix;
  source: { time: string; gps: string };
}

export interface GwConnection {
  connected: boolean;
  enabled: boolean;
  url: string;
  host: string;
  port: string;
  target: string;
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
  rejected: number;
  recent: GwMessageRecord[];
}

// Модуль доставки внутри активной конфигурации.
export interface GwModule {
  id: string;            // "websocket"
  title: string;         // "WebSocket"
  transport: string;     // "websocket" | "can" | "modbus"
  heartbeat_sec: number;
  protocol_versions: number[];
  connection: GwConnection;
  stats: GwStats;
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
