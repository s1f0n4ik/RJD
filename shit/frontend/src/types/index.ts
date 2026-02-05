export interface Camera {
  camera_name: string;
  rtsp_url: string;
  status: string;
  width?: number | null;
  height?: number | null;
  reconnect_interval?: number;
}

export interface Loader {
  loader_name: string;
  status: string;
  server_endpoint: string;
  loader_matrix?: string[][];
  img_size?: number;
  weights_path?: string;
  classes_path?: string;
}

export interface SystemState {
  cameras: Camera[];
  loaders: Loader[];
  summary?: {
    cameras_total: number;
    cameras_running: number;
    loaders_total: number;
    loaders_running: number;
  };
}

export interface CameraFormData {
  camera_name: string;
  rtsp_url: string;
  width?: number | null;
  height?: number | null;
  reconnect_interval: number;
}

export interface WebSocketMessage {
  type: string;
  data?: any;
  timestamp?: string;
  message?: string;
}