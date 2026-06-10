export interface CameraStream {
  codec: string;
  sub: number;
  fps: number;
  height: number;
  width: number;
  latency: number;
  reconnect: number;
  to_record: boolean;
  record_path: string;
  segment: number;
  rtsp: string;
  status: number;  // 0-нет, 1-готов, 2-остановлен, 3-запущен, 5-инициализирован
  type: number;    // 1-main, 2-sub
  use_udp: boolean;
}

export interface RealCamera {
  id: string;                 // 👈 NEW (бэк теперь возвращает id вместо name)
  display_name: string;       // 👈 NEW
  description: string;
  ip_adress: string;
  port: string;
  user: string;
  production?: number;        // 👈 заодно добавь, он же используется в UI
  type?: number;
  streams: {
    main: CameraStream;
    sub: CameraStream;
  };
}

// ✅ ПРЕОБРАЗОВАННЫЙ формат (после Object.values + добавления name)
export interface CPPCamera {
  id: string;  // Добавляется при конвертации
  display_name: string;
  description: string;
  ip_adress: string;
  port: string;
  user: string;
  password: string;
  production: number;
  type: number;
  streams: {
    main: CameraStream;
    sub: CameraStream;
  };
}

export interface NeuralLoader {
  loader_name: string;
  server_endpoint: string;
  img_size: number;
  status: 'running' | 'stopped';
  loader_matrix?: string[][];
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

export interface NeuralConfigurationListItem {
  id: string;
  name: string;
}

export interface NeuralSuperclass {
  name: string;
  color: string;
}

export interface NeuralClassItem {
  name: string;
  server_id: string;
  superclass: string;
  color: string;
}

export interface NeuralConfigurationBody {
  name: string;
  draw_groups: boolean;
  model_path: string;
  model_width: number;
  model_height: number;
  thresholds: {
    nms: number;
    confidence: number;
  };
  superclasses: Record<string, NeuralSuperclass>;
  classes: Record<string, NeuralClassItem>;
}

export interface NeuralStateItem {
  config_id: string;
  camera_matrix: string[][];
  cores: number[] | number;
}

export interface NeuralRuntimeStatusItem {
  config_id: string;
  camera_matrix: string[][];
  cores: number[] | number;
  running: boolean;
}