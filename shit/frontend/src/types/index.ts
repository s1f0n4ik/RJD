export interface CPPCameraStream {
  type_url: number;
  username: string;
  password: string;
  record_path?: string;
  length?: number;
  delete_delay?: number;
  use_udp: boolean;
  status?: number; // 0-нет, 1-готов, 2-остановлен, 3-в работе
}

export interface CPPCamera {
  name: string;
  description: string;
  main: CPPCameraStream;
  sub: CPPCameraStream;
  reconnect: number;
}

export interface NeuralLoader {
  loader_name: string;
  server_endpoint: string;
  img_size: number;
  status: 'running' | 'stopped';
  loader_matrix?: string[][];
}

export interface Camera {
  camera_name: string;
  rtsp_url: string;
  width?: number | null;
  height?: number | null;
  reconnect_interval?: number;
  status?: string;
}

export interface CameraFormData {
  camera_name: string;
  rtsp_url: string;
  width: number | null;
  height: number | null;
  reconnect_interval: number;
}

export interface SystemState {
  cameras: CPPCamera[];
  loaders: NeuralLoader[];
  summary?: {
    cameras_total: number;
    cameras_running: number;
  };
}

export interface WebSocketMessage {
  type: string;
  data?: SystemState;
  timestamp?: string;
  message?: string;
}