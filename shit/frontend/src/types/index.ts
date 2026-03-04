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

// ? ƒќЅј¬Ћя≈ћ недостающие типы
export interface NeuralLoader {
  loader_name: string;
  server_endpoint: string;
  img_size: number;
  status: 'running' | 'stopped';
  loader_matrix?: string[][];
}

export interface SystemState {
  cameras: CPPCamera[];
  loaders: NeuralLoader[]; // ? ƒќЅј¬Ћ≈Ќќ!
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