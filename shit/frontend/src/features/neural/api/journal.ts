import type {
  JournalDetectionFull,
  JournalFilters,
  JournalHead,
  JournalListResponse,
  JournalSummary,
  Verdict,
} from './journal-types';

// Журнал ведёт мастер обнаружений: nginx отдаёт /api/journal в detection-service
const BASE = '/api/journal';

// Корень задач выгрузки журнала для панели загрузок
export const JOURNAL_JOBS = `${BASE}/jobs`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.detail ?? body?.error ?? detail;
    } catch {
      /* тело не JSON */
    }
    throw new Error(`${res.status} · ${detail}`);
  }
  return res.json() as Promise<T>;
}

const send = <T,>(path: string, method: string, body: unknown): Promise<T> =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<T>);

export interface JournalStorageState {
  // Лимиты в ГБ; 0 — ограничение выключено
  images_limit_gb: number;
  db_limit_gb: number;
  frames_bytes: number;
  db_bytes: number;
}

export interface JournalPurgeResult extends JournalStorageState {
  deleted: number;
  files_deleted: number;
}

export interface JournalExportRequest {
  t_from?: number;
  t_to?: number;
  verdict?: Verdict;
  device_id?: string;
  camera_id?: string;
  config_id?: string;
  cids?: number[];
  boxes: boolean;
  data: boolean;
  legend: Record<string, { name: string; color: string }>;
  title: string;
  subtitle: string;
}

interface ListOpts {
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
  // min_lon,min_lat,max_lon,max_lat
  bbox?: [number, number, number, number];
}

function filterQuery(f: JournalFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (f.tFrom != null) q.set('t_from', String(f.tFrom));
  if (f.tTo != null) q.set('t_to', String(f.tTo));
  if (f.verdict) q.set('verdict', f.verdict);
  if (f.cids && f.cids.length) q.set('cids', f.cids.join(','));
  if (f.deviceId) q.set('device_id', f.deviceId);
  if (f.cameraId) q.set('camera_id', f.cameraId);
  if (f.configId) q.set('config_id', f.configId);
  return q;
}

// Тело выгрузки с теми же фильтрами, что у списка
export const exportFilters = (f: JournalFilters) => ({
  t_from: f.tFrom,
  t_to: f.tTo,
  verdict: f.verdict,
  device_id: f.deviceId,
  camera_id: f.cameraId,
  config_id: f.configId,
  cids: f.cids,
});

export const journalApi = {
  list(filters: JournalFilters, opts: ListOpts = {}): Promise<JournalListResponse> {
    const q = filterQuery(filters);
    if (opts.bbox) q.set('bbox', opts.bbox.join(','));
    q.set('limit', String(opts.limit ?? 100));
    q.set('offset', String(opts.offset ?? 0));
    q.set('order', opts.order ?? 'desc');
    return fetch(`${BASE}/detections?${q}`).then(json<JournalListResponse>);
  },

  // Лёгкий опрос изменений по тем же фильтрам, что и список
  head(filters: JournalFilters): Promise<JournalHead> {
    return fetch(`${BASE}/head?${filterQuery(filters)}`).then(json<JournalHead>);
  },

  summary(filters: JournalFilters): Promise<JournalSummary> {
    return fetch(`${BASE}/summary?${filterQuery(filters)}`).then(json<JournalSummary>);
  },

  get(id: number): Promise<JournalDetectionFull> {
    return fetch(`${BASE}/detections/${id}`).then(json<JournalDetectionFull>);
  },

  setVerdict(id: number, verdict: Verdict, note?: string): Promise<{ ok: boolean }> {
    return send(`/detections/${id}/verdict`, 'PATCH', { verdict, note: note ?? null });
  },

  // Архив превью по фильтрам; ход — в панели загрузок
  export(body: JournalExportRequest): Promise<{ job_id: string }> {
    return send('/export', 'POST', body);
  },

  frameUrl(id: number): string {
    return `${BASE}/frame/${id}.jpg`;
  },

  storageState(): Promise<JournalStorageState> {
    return fetch(`${BASE}/settings`).then(json<JournalStorageState>);
  },

  saveStorageSettings(imagesLimitGb: number, dbLimitGb: number): Promise<JournalStorageState> {
    return send('/settings', 'POST', { images_limit_gb: imagesLimitGb, db_limit_gb: dbLimitGb });
  },

  // Очистка закрытых обнаружений со снимками; beforeTs — только старше
  purge(beforeTs?: number): Promise<JournalPurgeResult> {
    return send('/purge', 'POST', { before_ts: beforeTs ?? null });
  },

  styleUrl(): string {
    return `${BASE}/map/style.json`;
  },

  // Воркер MapLibre не понимает относительных путей
  resourceUrl(path: string): string {
    return new URL(path, window.location.origin).href;
  },
};
