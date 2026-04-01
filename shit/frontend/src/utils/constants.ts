// Используем относительные пути - nginx будет проксировать
export const FASTAPI_BASE = '';  // Пустая строка = текущий хост
export const WS_BASE = location.protocol === 'https:' ? 'wss://' : 'ws://';

// WebSocket через nginx
export const WS_URL = `${WS_BASE}${location.host}/ws`;

// Signaling через nginx
export const SIGNALING_SERVER = `${WS_BASE}${location.host}/signaling`;

export const ENDPOINT_MAP: Record<string, string> = {
  'id_1': '/neural_1',
  'id_2': '/neural_2',
  'id_3': '/neural_3',
};

export const CAMERA_TYPE_URLS = {
  HIKVISION: 1,
  DAHUA: 2,
  ACE: 3,
  BEWARD: 4,
} as const;

export const CAMERA_STATUS = {
  NO_PIPELINE: 0,
  READY: 1,
  STOPPED: 2,
  RUNNING: 3,
} as const;