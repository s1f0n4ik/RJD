// ─────────────────────────────────────────────────────────────
//  Типы журнала обнаружений (storage-service, /api/journal).
//  Журнал config-агностичен: объект несёт только id класса (cid),
//  а имя/цвет/суперкласс резолвит фронт по config_id.
// ─────────────────────────────────────────────────────────────

export type Verdict = 'unverified' | 'true' | 'false';

/** Один объект на кадре: id класса + confidence + бокс [x,y,w,h] в пикселях. */
export interface JournalObject {
  cid: number;
  cf: number;
  box: [number, number, number, number];
}

/** Снимок GPS в момент кадра (null — координат не было). */
export interface JournalGps {
  lat: number;
  lon: number;
  alt: number;
  speed: number;
  course: number;
}

/** Одна запись журнала (строка detections + разобранный dets_json). */
export interface JournalDetection {
  id: number;
  ts: number; // unix ms
  camera_id: string;
  config_id: string | null;
  gps: JournalGps | null;
  width: number;
  height: number;
  track_id: number | null;
  event: string | null;
  objects: JournalObject[];
  verdict: Verdict;
  verdict_note: string | null;
  verdict_at: number | null;
  frame_url: string;
}

export interface JournalListResponse {
  detections: JournalDetection[];
  total: number;
  limit: number;
  offset: number;
}

/** Фильтры списка. cids — id классов (фронт разворачивает выбор по конфигурации). */
export interface JournalFilters {
  tFrom?: number;
  tTo?: number;
  verdict?: Verdict;
  cids?: number[];
  cameraId?: string;
  configId?: string;
}
