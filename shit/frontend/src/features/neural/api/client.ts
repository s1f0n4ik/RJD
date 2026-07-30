import type {
  ActiveDesc,
  CameraInfo,
  ClassDef,
  ConfigSummary,
  ImportMode,
  ModelFile,
  NeuralConfig,
  SlotStatus,
  SuperclassDef,
  SystemInfo,
  TrackEventType,
  TrackerType,
} from './types';

// ═════════════════════════════════════════════════════════════
//  ЕДИНАЯ ТОЧКА СМЕНЫ АДРЕСА БЭКЕНДА.
//
//  DEV  — хардкод IP оранжпи на время разработки (меняйте здесь).
//  PROD — пустая строка: тот же origin, nginx проксирует /neural/.
//
//  Ручки совпадают с nginx (location /neural/ → media_center).
// ═════════════════════════════════════════════════════════════
// export const API_HOST = 'http://192.168.1.2';
export const API_HOST = ''; // ← раскомментировать для prod-сборки

import { modulePath } from '../../../services/devices';

// Ручки /neural/* переезжают на устройство, назначенное модулю neural
const url = (path: string) =>
    path.startsWith('/neural/') ? `${API_HOST}${modulePath('neural', path)}` : `${API_HOST}${path}`;

/** Снимает обёртку { data: ... } и кидает осмысленную ошибку на не-2xx. */
async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.error ?? body?.message ?? body?.detail ?? detail;
    } catch {
      /* тело не JSON — оставляем statusText */
    }
    throw new Error(`${res.status} · ${detail}`);
  }
  const json = await res.json();
  return (json?.data ?? json) as T;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export const neuralApi = {
  // ── Конфигурации ───────────────────────────────────────────
  listConfigurations(): Promise<{ configurations: ConfigSummary[] }> {
    return fetch(url('/neural/configurations')).then(unwrap);
  },

  getConfiguration(id: string): Promise<NeuralConfig> {
    return fetch(url(`/neural/configurations?id=${encodeURIComponent(id)}`)).then(unwrap);
  },

  /** POST /neural/configurations — { mode, data: { <id>: config } } */
  importConfigurations(data: Record<string, NeuralConfig>, mode: ImportMode): Promise<unknown> {
    return fetch(url('/neural/configurations'), {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ mode, data }),
    }).then(unwrap);
  },

  // ── Состояние (state) ──────────────────────────────────────
  getState(): Promise<ActiveDesc[]> {
    return fetch(url('/neural/state')).then(unwrap);
  },

  /** POST /neural/state — тело это массив дескрипторов напрямую */
  setState(descs: ActiveDesc[]): Promise<unknown> {
    return fetch(url('/neural/state'), {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(descs),
    }).then(unwrap);
  },

  // ── Статус слотов ──────────────────────────────────────────
  getStatus(): Promise<SlotStatus[]> {
    return fetch(url('/neural/status')).then(unwrap);
  },

  // ── Управление супервизором ────────────────────────────────
  start(): Promise<unknown> {
    return fetch(url('/neural/start'), { method: 'POST' }).then(unwrap);
  },
  restart(): Promise<unknown> {
    return fetch(url('/neural/restart'), { method: 'POST' }).then(unwrap);
  },
  stop(): Promise<unknown> {
    return fetch(url('/neural/stop'), { method: 'POST' }).then(unwrap);
  },

  // ── Классы / суперклассы конкретной конфигурации ───────────
  getClasses(configId: string): Promise<{ config_id: string; classes: (ClassDef & { id: string })[] }> {
    return fetch(url(`/neural/classes?config_id=${encodeURIComponent(configId)}`)).then(unwrap);
  },
  getSuperclasses(
    configId: string,
  ): Promise<{ config_id: string; superclasses: (SuperclassDef & { key: string })[] }> {
    return fetch(url(`/neural/superclasses?config_id=${encodeURIComponent(configId)}`)).then(unwrap);
  },

  // ── Типы трекеров («фильтров») ─────────────────────────────
  getTrackerTypes(): Promise<{ types: TrackerType[] }> {
    return fetch(url('/neural/tracker-types')).then(unwrap);
  },

  // ── Тип платформы и лимиты потоков ─────────────────────────
  getSystem(): Promise<SystemInfo> {
    return fetch(url('/neural/system')).then(unwrap);
  },

  // ── Возможные события трека (идентификаторы) ───────────────
  getEventTypes(): Promise<{ events: TrackEventType[] }> {
    return fetch(url('/neural/event-types')).then(unwrap);
  },

  // ── Модели ─────────────────────────────────────────────────
  listModels(): Promise<ModelFile[]> {
    return fetch(url('/neural/models')).then(unwrap);
  },

  /** POST /neural/models?filename=*.rknn — тело это бинарь файла */
  uploadModel(file: File): Promise<ModelFile> {
    return fetch(url(`/neural/models?filename=${encodeURIComponent(file.name)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }).then(unwrap);
  },

  // ── Поиск конфигурации по камере ───────────────────────────
  findCameraConfig(cameraId: string): Promise<{ camera_id: string; config_id: string | null; found: boolean }> {
    return fetch(url(`/neural/camera?camera_id=${encodeURIComponent(cameraId)}`)).then(unwrap);
  },

  // ── Список камер (GET /camera, controller.cpp) ─────────────
  listCameras(): Promise<{ cameras: Record<string, CameraInfo> | null }> {
    return fetch(url('/api/cameras')).then(unwrap<{ cameras: Record<string, CameraInfo> | null }>);
  },
};
