// Типы журнала обнаружений мастера (detection-service, /api/journal)

export type Verdict = 'unverified' | 'true' | 'false';

export type ClosedReason = 'removed' | 'device_restart' | 'link_lost' | 'config_changed' | 'master_restart';

// Рамка [x, y, w, h] в пикселях кадра
export type Box = [number, number, number, number];

// GPS первого события обнаружения; скорость в м/с
export interface JournalGps {
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null;
  course: number | null;
}

// Снимок обнаружения с рамкой трека
export interface JournalShot {
  image_id: number;
  url: string;
  box: Box | null;
  frame_w: number | null;
  frame_h: number | null;
  confidence: number | null;
  ts: number | null;
  track_no: number | null;
}

export interface JournalPreview {
  image_id: number;
  box?: Box | null;
  frame_w?: number | null;
  frame_h?: number | null;
  confidence?: number | null;
  ts?: number | null;
  track_no?: number | null;
}

export interface JournalDetection {
  id: number;
  device_id: string;
  camera_id: string;
  config_id: string | null;
  class_id: number | null;
  class_name: string | null;
  superclass: string | null;
  // Настенное время шлюза, закодированное как UTC
  started_at: number;
  ended_at: number | null;
  closed_reason: ClosedReason | null;
  late: boolean;
  tracks: number;
  images: number;
  preview: JournalPreview | null;
  gps: JournalGps | null;
  verdict: Verdict;
  verdict_note: string | null;
  verdict_at: number | null;
  frame_url: string | null;
}

export interface JournalTrack {
  track_no: number;
  class_id: number | null;
  class_name: string | null;
  superclass: string | null;
  first_ts: number;
  last_ts: number;
}

export interface JournalImage {
  image_id: number;
  ts: number;
  track_no: number;
  box: Box | null;
  frame_w: number | null;
  frame_h: number | null;
  confidence: number | null;
  url: string;
}

export interface JournalDetectionFull extends JournalDetection {
  track_list: JournalTrack[];
  image_list: JournalImage[];
}

export interface JournalListResponse {
  detections: JournalDetection[];
  total: number;
  limit: number;
  offset: number;
}

export interface JournalHead {
  max_id: number;
  total: number;
  open: number;
}

export interface JournalSummary {
  total: number;
  verdicts: Record<Verdict, number>;
  devices: { device_id: string; count: number }[];
  cameras: { device_id: string; camera_id: string; count: number; true: number; false: number; unverified: number }[];
  classes: { superclass: string | null; class_id: number | null; class_name: string | null; count: number }[];
  hours: number[];
  // Часы суток — по каждому дню
  days: { day: string; count: number; hours: number[] }[];
}

// Фильтры списка; cids — id классов выбранной конфигурации
export interface JournalFilters {
  tFrom?: number;
  tTo?: number;
  verdict?: Verdict;
  cids?: number[];
  deviceId?: string;
  cameraId?: string;
  configId?: string;
}
