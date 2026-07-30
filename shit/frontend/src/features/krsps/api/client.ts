import type {
  GwCanConfigPatch,
  GwDevices,
  GwIntegrations,
  GwModule,
  GwStatus,
  GwTaxonomy,
  GwTaxonomyPatch,
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

  // Обновление настроек CAN-модуля активной конфигурации.
  async updateCanConfig(patch: GwCanConfigPatch): Promise<GwStatus> {
    return unwrap<GwStatus>(
      await fetch(url('/config/can'), {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(patch),
      }),
    );
  },

  // Подключение/отключение конкретного модуля: у конфигурации их несколько, и
  // гасить весь канал ради одного не нужно.
  async connectModule(module: string): Promise<GwModule> {
    return unwrap<GwModule>(
      await fetch(url('/modules/connect'), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ module }),
      }),
    );
  },

  async disconnectModule(module: string): Promise<GwModule> {
    return unwrap<GwModule>(
      await fetch(url('/modules/disconnect'), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ module }),
      }),
    );
  },

  // Общая таблица соответствий: одна на весь шлюз.
  async getTaxonomy(): Promise<GwTaxonomy> {
    return unwrap<GwTaxonomy>(await fetch(url('/taxonomy')));
  },

  async updateTaxonomy(patch: GwTaxonomyPatch): Promise<GwTaxonomy> {
    return unwrap<GwTaxonomy>(
      await fetch(url('/taxonomy'), {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(patch),
      }),
    );
  },

  // Что шлюз видит на машине: интерфейсы CAN и serial-порты.
  async getDevices(): Promise<GwDevices> {
    return unwrap<GwDevices>(await fetch(url('/devices')));
  },

  async getTime(): Promise<GwTime> {
    return unwrap<GwTime>(await fetch(url('/time')));
  },

  // Часовой пояс выдачи времени; шлюз сохраняет его и отвечает свежим снимком.
  async setTimeZone(tzOffsetMin: number): Promise<GwTime> {
    return unwrap<GwTime>(
      await fetch(url('/config/time'), {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ tz_offset_min: tzOffsetMin }),
      }),
    );
  },
};
