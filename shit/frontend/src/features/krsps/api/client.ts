import type {
  GwCanConfigPatch,
  GwDevices,
  GwIntegrations,
  GwModbusConfigPatch,
  GwModule,
  GwStatus,
  GwTime,
  GwWsConfigPatch,
} from '../types';
import { refreshDeviceClock } from '../../../app/useDeviceClock';

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
      detail = body?.detail ?? body?.error ?? body?.message ?? detail;
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


  async getStatus(): Promise<GwStatus> {
    return unwrap<GwStatus>(await fetch(`${API_HOST}/api/configurations/gateway/status`));
  },

  // Обновление настроек WebSocket-модуля активной конфигурации.
  async updateWsConfig(patch: GwWsConfigPatch): Promise<GwStatus> {
    return unwrap<GwStatus>(
      await fetch(`${API_HOST}/api/configurations/gateway/websocket`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(patch),
      }),
    );
  },

  // Обновление настроек CAN-модуля активной конфигурации.
  async updateCanConfig(patch: GwCanConfigPatch): Promise<GwStatus> {
    return unwrap<GwStatus>(
      await fetch(`${API_HOST}/api/configurations/gateway/can`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(patch),
      }),
    );
  },

  // Обновление настроек Modbus-модуля активной конфигурации.
  async updateModbusConfig(patch: GwModbusConfigPatch): Promise<GwStatus> {
    return unwrap<GwStatus>(
      await fetch(`${API_HOST}/api/configurations/gateway/modbus`, {
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

  // Что шлюз видит на машине: интерфейсы CAN и serial-порты.
  async getDevices(): Promise<GwDevices> {
    return unwrap<GwDevices>(await fetch(url('/devices')));
  },

  async getTime(): Promise<GwTime> {
    return unwrap<GwTime>(await fetch(`${API_HOST}/api/time`));
  },

  // Часовой пояс сохраняется в паспорте активного профиля.
  async setTimeZone(tzOffsetMin: number, profileId: string): Promise<{ time: GwTime | null; applied: boolean }> {
    const result = await unwrap<{ applied: boolean }>(
      await fetch(`${API_HOST}/api/time/config`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ tz_offset_min: tzOffsetMin, profile_id: profileId }),
      }),
    );
    await refreshDeviceClock();
    const time = await krspsApi.getTime().catch(() => null);
    return { time, applied: result.applied };
  },
};
