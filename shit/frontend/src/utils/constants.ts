export const WS_URL = 'ws://192.168.1.2:8000/ws';
export const FASTAPI_BASE = 'http://192.168.1.2:8000';
export const FLASK_BASE = 'http://192.168.1.2:5000';

export const ENDPOINT_MAP: Record<string, string> = {
  'id_1': '/neural_1',
  'id_2': '/neural_2',
  'id_3': '/neural_3',
};

export const ALLOWED_IMG_SIZES = [320, 416, 640, 1280];
export const AVAILABLE_ENDPOINTS = ['/neural_1', '/neural_2', '/neural_3'];