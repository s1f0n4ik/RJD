export const WS_URL = 'ws://192.168.1.2:8000/ws';
export const FASTAPI_BASE = 'http://192.168.1.2:8000';
export const SIGNALING_SERVER = 'ws://192.168.1.2:8765';
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