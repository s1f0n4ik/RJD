export interface CPPCameraStream {
  type_url: number;
  username: string;
  password: string;
  record_path?: string;
  length?: number;
  delete_delay?: number;
  use_udp: boolean;
  status?: number;
}

export interface CPPCamera {
  name: string;
  description: string;
  main: CPPCameraStream;
  sub: CPPCameraStream;
  reconnect: number;
}

export interface SystemState {
  cameras: CPPCamera[];
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