import type {
  GwIntegrations,
  GwStatus,
  GwTime,
  GwWsConfigPatch,
} from '../types';

// Единая точка смены адреса шлюза. В prod — пустая строка (тот же origin,
// nginx проксирует /api/gateway/* → message_gateway, срезая префикс). В dev
// можно указать IP оранжпи. Ручки шлюза см. message-gateway/README.md.
// export const API_HOST = 'http://192.168.1.2';
export const API_HOST = '';

const BASE = '/api/gateway';
const url = (path: string) => `${API_HOST}${BASE}${path}`;

// Шлюз отдаёт JSON без обёртки; ошибка приходит как { error }.
async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.error ?? body?.message ?? detail;
    } catch {
      /* тело не JSON — оставляем statusText */
    }
    throw new Error(`${res.status} · ${detail}`);
  }
  return (await res.json()) as T;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export const krspsApi = {
  async getIntegrations(): Promise<GwIntegrations> {
    return unwrap<GwIntegrations>(await fetch(url('/integrations')));
  },

  async selectIntegration(id: string): Promise<GwStatus> {
    return unwrap<GwStatus>(
      await fetch(url('/integrations/select'), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ id }),
      }),
    );
  },

  async getStatus(): Promise<GwStatus> {
    return unwrap<GwStatus>(await fetch(url('/status')));
  },

  // Обновление настроек WebSocket-модуля активной конфигурации.
  async updateWsConfig(patch: GwWsConfigPatch): Promise<GwStatus> {
    return unwrap<GwStatus>(
      await fetch(url('/config/websocket'), {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(patch),
      }),
    );
  },

  async connect(): Promise<unknown> {
    return unwrap<unknown>(await fetch(url('/ws/connect'), { method: 'POST' }));
  },

  async disconnect(): Promise<unknown> {
    return unwrap<unknown>(await fetch(url('/ws/disconnect'), { method: 'POST' }));
  },

  async getTime(): Promise<GwTime> {
    return unwrap<GwTime>(await fetch(url('/time')));
  },
};
