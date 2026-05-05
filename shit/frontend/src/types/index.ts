export interface CameraStream {
  codec: string;
  fps: number;
  height: number;
  width: number;
  latency: number;
  reconnect: number;
  record_path: string;
  rtsp: string;
  segment: number;
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