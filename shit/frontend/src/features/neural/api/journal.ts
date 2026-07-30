import { API_HOST } from './client';
import { moduleDeviceId, storagePath } from '../../../services/devices';
import type { JournalDetection, JournalFilters, JournalListResponse, Verdict } from './journal-types';

// Журнал пишет нейронка — он живёт на storage-service её устройства
const url = (path: string) => `${API_HOST}${storagePath(moduleDeviceId('neural'), path)}`;

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

export interface JournalStorageState {
  /** Лимиты в ГБ; 0 = ограничение выключено. */
  images_limit_gb: number;
  db_limit_gb: number;
  frames_bytes: number;
  db_bytes: number;
}

export interface JournalPurgeResult extends JournalStorageState {
  deleted: number;
  files_deleted: number;
}

interface ListOpts {
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
  bbox?: [number, number, number, number]; // min_lon,min_lat,max_lon,max_lat
}

function buildQuery(f: JournalFilters, opts: ListOpts): string {
  const q = new URLSearchParams();
  if (f.tFrom != null) q.set('t_from', String(f.tFrom));
  if (f.tTo != null) q.set('t_to', String(f.tTo));
  if (f.verdict) q.set('verdict', f.verdict);
  if (f.cids && f.cids.length) q.set('cids', f.cids.join(','));
  if (f.cameraId) q.set('camera_id', f.cameraId);
  if (f.configId) q.set('config_id', f.configId);
  if (opts.bbox) q.set('bbox', opts.bbox.join(','));
  q.set('limit', String(opts.limit ?? 100));
  q.set('offset', String(opts.offset ?? 0));
  q.set('order', opts.order ?? 'desc');
  return q.toString();
}

export const journalApi = {
  list(filters: JournalFilters, opts: ListOpts = {}): Promise<JournalListResponse> {
    return fetch(url(`/api/journal/detections?${buildQuery(filters, opts)}`)).then(json<JournalListResponse>);
  },

  /** Лёгкая ручка для опроса: {max_id, total} по тем же фильтрам, что и список. */
  head(filters: JournalFilters): Promise<{ max_id: number; total: number }> {
    const q = new URLSearchParams();
    if (filters.tFrom != null) q.set('t_from', String(filters.tFrom));
    if (filters.tTo != null) q.set('t_to', String(filters.tTo));
    if (filters.verdict) q.set('verdict', filters.verdict);
    if (filters.cids && filters.cids.length) q.set('cids', filters.cids.join(','));
    if (filters.cameraId) q.set('camera_id', filters.cameraId);
    if (filters.configId) q.set('config_id', filters.configId);
    return fetch(url(`/api/journal/head?${q.toString()}`)).then(json<{ max_id: number; total: number }>);
  },

  get(id: number): Promise<JournalDetection> {
    return fetch(url(`/api/journal/detections/${id}`)).then(json<JournalDetection>);
  },

  setVerdict(id: number, verdict: Verdict, note?: string): Promise<{ ok: boolean }> {
    return fetch(url(`/api/journal/detections/${id}/verdict`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict, note: note ?? null }),
    }).then(json<{ ok: boolean }>);
  },

  frameUrl(id: number): string {
    return url(`/api/journal/frame/${id}.jpg`);
  },

  /** Лимиты хранилища журнала и фактическая занятость. */
  storageState(): Promise<JournalStorageState> {
    return fetch(url('/api/journal/settings')).then(json<JournalStorageState>);
  },

  saveStorageSettings(imagesLimitGb: number, dbLimitGb: number): Promise<JournalStorageState> {
    return fetch(url('/api/journal/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images_limit_gb: imagesLimitGb, db_limit_gb: dbLimitGb }),
    }).then(json<JournalStorageState>);
  },

  /** Очистка: записи вместе с изображениями; beforeTs (unix ms) — только старше. */
  purge(beforeTs?: number): Promise<JournalPurgeResult> {
    return fetch(url('/api/journal/purge'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ before_ts: beforeTs ?? null }),
    }).then(json<JournalPurgeResult>);
  },

  /** Стиль MapLibre — раздаётся со своего origin вместе с глифами (offline). */
  styleUrl(): string {
    return url('/api/journal/map/style.json');
  },

  /** Абсолютный URL ресурса журнала — воркер MapLibre не умеет относительные пути. */
  resourceUrl(path: string): string {
    return new URL(url(path), window.location.origin).href;
  },
};
