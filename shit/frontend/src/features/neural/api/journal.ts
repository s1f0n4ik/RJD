import { API_HOST } from './client';
import type { JournalDetection, JournalFilters, JournalListResponse, Verdict } from './journal-types';

const url = (path: string) => `${API_HOST}${path}`;

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

  /** Стиль MapLibre — раздаётся со своего origin вместе с глифами (offline). */
  styleUrl(): string {
    return url('/api/journal/map/style.json');
  },
};
