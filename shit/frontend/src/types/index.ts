import type { Device, RoutingTable } from '../services/devices';
import type { GatewaySummary, NeuralSummary } from '../screens/home/useHomeData';

// Назначение потока: имена совпадают с именами модулей устройства
export type StreamPurpose = 'view' | 'record' | 'neural' | 'birdview' | 'rtp';

// Куда и как уходит RTP-трансляция потока; рамка и битрейт: 0 — как у исходного потока
export interface RtpSettings {
  host: string;
  port: number;
  mode: 'copy' | 'transcode';
  width: number;
  height: number;
  // кбит/с
  bitrate: number;
  // 0..51, чем больше, тем сильнее сжатие
  qp_max: number;
}

// Формат кадра камеры на плате: четвёрка V4L2
export type V4l2Format = 'YUYV' | 'UYVY' | 'NV12' | 'MJPG';

// Камера на плате: узел V4L2, режим захвата и кодирование в H.264
export interface V4l2Source {
  // USB — путь /dev/v4l/by-path/..., CSI — имя узла, например rkisp_mainpath
  device: string;
  format: V4l2Format;
  width: number;
  height: number;
  fps: number;
  // По часовой стрелке: 0, 90, 180 или 270
  rotation: number;
  swap_uv: boolean;
  // кбит/с, 0 — выбирает кодек
  bitrate: number;
  // Секунд между опорными кадрами
  gop: number;
}

// Камера, которую media-center нашёл на плате: GET /camera/local
export interface LocalCamera {
  device: string;
  node: string;
  name: string;
  kind: 'usb' | 'csi';
  // Модель сенсора CSI; пусто у USB
  sensor: string;
  // Камера, которая уже держит это устройство
  used_by: string | null;
  formats: Array<{
    format: string;
    sizes?: Array<{ width: number; height: number; fps: number[] }>;
    // Кадр масштабирует ISP: диапазон с шагом вместо списка
    range?: { min_width: number; max_width: number; step_width: number; min_height: number; max_height: number; step_height: number };
  }>;
}

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
  // Есть только у потока с назначением rtp
  rtp?: RtpSettings;
  rtsp: string;
  status: number;  // 0-нет, 1-готов, 2-остановлен, 3-запущен, 5-инициализирован
  use_udp: boolean;
  // Почему поток не поднялся: код media-center 3xxx; поля нет, пока всё в порядке или плата старая
  error?: { code: number; since: number; attempts: number };
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
  // Нет поля — камера в сети; v4l2 — камера на плате с настройками ниже
  source?: 'rtsp' | 'v4l2';
  v4l2?: V4l2Source;
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
    // Только у birdview: режим основного потока и второй поток при двойном выводе
    view_mode?: 'top' | 'surround';
    secondary?: { stream_id: string; view_mode: 'top' | 'surround'; width: number; height: number } | null;
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
  devices?: Device[];
  routing?: Partial<RoutingTable>;
  // Сводки: null — источник не ответил; поля нет, пока сводки не приходили
  neural?: NeuralSummary | null;
  gateway?: GatewaySummary | null;
  linker?: LinkerSnapshot | null;
  // Модули устройств по действующему профилю: id устройства → модули; null — профиля нет, поля нет у старого бэкенда
  active_modules?: Record<string, string[]> | null;
}

// Сводка вывода 360 как её шлёт бэкенд
export interface LinkerSnapshot {
  running: boolean;
  view_mode: string;
  dual_output: boolean;
}

export interface WebSocketMessage {
  type: string;
  // Время сервера, unix-секунды
  ts?: number;
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