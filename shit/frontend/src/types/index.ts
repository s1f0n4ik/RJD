// Назначение потока: имена совпадают с именами модулей устройства
export type StreamPurpose = 'view' | 'record' | 'neural' | 'birdview';

export interface CameraStream {
  codec: string;
  // Физический вход камеры и качество той же картинки
  channel: number;
  substream: number;
  purposes: StreamPurpose[];
  fps: number;
  height: number;
  width: number;
  latency: number;
  reconnect: number;
  record_path: string;
  segment: number;
  rtsp: string;
  status: number;  // 0-нет, 1-готов, 2-остановлен, 3-запущен, 5-инициализирован
  use_udp: boolean;
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
  // Ключи — stream_1…stream_N, порядковые и неизменяемые
  streams: Record<string, CameraStream>;
  // Устройство-владелец из агрегированного списка
  device_id?: string;
  device_name?: string;
  // Устройство не ответило, данные из кэша мастера
  offline?: boolean;
}

// Проба потока: media-center подключается к камере, но её не создаёт
export interface ProbeRequest {
  ip_adress: string;
  port: string;
  user: string;
  password: string;
  production: number;
  channel?: number;
  substream?: number;
  timeout?: number;
}

export type ProbeReason = 'auth' | 'unreachable' | 'no_stream' | 'timeout' | 'decoder';

export interface ProbeResult {
  result: 'success' | 'error';
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  reason?: ProbeReason;
  details?: string;
}

// Кто собрал поток
export type StreamProducer = 'birdview' | 'neural';

// Поток поверх камер: сборка 360 или нейронный слот
export interface VirtualStream {
    // Совпадает с id комнаты сигналинга
    id: string;
    // Может быть пустым, тогда показывается id
    name: string;
    producer: StreamProducer;
    // id конфигурации сборки или конфигурации нейросети
    source_id: string;
    source_name: string;
    // Камеры источника, без повторов
    cameras: string[];
    // Нули - вывода ещё не было
    width: number;
    height: number;
    running: boolean;
    // Устройство-владелец из агрегированного списка
    device_id?: string;
    device_name?: string;
    // Устройство не ответило, данные из кэша мастера
    offline?: boolean;
}

// Общий минимум камеры и потока, всё, что нужно сетке и киоску
export interface StreamSource {
    id: string;
    name: string;
    active: boolean;
    // Что внутри потока, у камеры пусто
    detail?: string;
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