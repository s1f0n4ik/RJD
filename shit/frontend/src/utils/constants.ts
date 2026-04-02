const getBaseUrl = () => {
  // Используем текущий хост из браузера
  const protocol = window.location.protocol; // http: или https:
  const host = window.location.host; // 192.168.1.2:80 или 172.25.78.137:8081

  return `${protocol}//${host}`;
};

const getWsProtocol = () => {
  return window.location.protocol === 'https:' ? 'wss:' : 'ws:';
};

// API и WebSocket используют ОТНОСИТЕЛЬНЫЕ пути (проксируются через nginx)
export const FASTAPI_BASE = getBaseUrl(); // http://текущий_хост
export const WS_URL = `${getWsProtocol()}//${window.location.host}/ws`; // ws://текущий_хост/ws

// Signaling на порту 8765 (нужно пробрасывать через nginx или использовать host)
export const SIGNALING_SERVER = `${getWsProtocol()}//${window.location.hostname}:8765`;

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