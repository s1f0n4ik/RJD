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
import { modulePath } from '../../../services/devices';

// Пустая строка — тот же origin, прокси бэкенда ведёт на устройство модуля
export const API_HOST = '';

// Ручки /neural/* переезжают на устройство, назначенное модулю neural
const url = (path: string) =>
    path.startsWith('/neural/') ? `${API_HOST}${modulePath('neural', path)}` : `${API_HOST}${path}`;

// Снимает обёртку { data: ... } и кидает осмысленную ошибку на не-2xx
async function unwrap<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let detail = res.statusText;
        try {
            const body = await res.json();
            detail = body?.error ?? body?.message ?? body?.detail ?? detail;
        } catch {
            // тело не JSON — остаётся statusText
        }
        throw new Error(`${res.status} · ${detail}`);
    }
    const json = await res.json();
    return (json?.data ?? json) as T;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

const get = <T,>(path: string): Promise<T> => fetch(url(path)).then(res => unwrap<T>(res));
const send = <T,>(path: string, method: string, body?: unknown): Promise<T> =>
    fetch(url(path), { method, headers: body === undefined ? undefined : jsonHeaders, body: body === undefined ? undefined : JSON.stringify(body) })
        .then(res => unwrap<T>(res));

export const neuralApi = {
    // ── Конфигурации ──
    listConfigurations: () => get<{ configurations: ConfigSummary[] }>('/neural/configurations'),

    getConfiguration: (id: string) => get<NeuralConfig>(`/neural/configurations?id=${encodeURIComponent(id)}`),

    /** POST /neural/configurations — { mode, data: { <id>: config } } */
    importConfigurations: (data: Record<string, NeuralConfig>, mode: ImportMode) =>
        send<unknown>('/neural/configurations', 'POST', { mode, data }),

    /** DELETE /neural/configurations?id= — 409, если конфигурация занята слотом */
    deleteConfiguration: (id: string) => send<unknown>(`/neural/configurations?id=${encodeURIComponent(id)}`, 'DELETE'),

    // ── Состояние слотов ──
    getState: () => get<ActiveDesc[]>('/neural/state'),

    /** POST /neural/state — тело это массив дескрипторов напрямую */
    setState: (descs: ActiveDesc[]) => send<unknown>('/neural/state', 'POST', descs),

    getStatus: () => get<SlotStatus[]>('/neural/status'),

    // ── Супервизор ──
    start: () => send<unknown>('/neural/start', 'POST'),
    restart: () => send<unknown>('/neural/restart', 'POST'),
    stop: () => send<unknown>('/neural/stop', 'POST'),

    // ── Классы и суперклассы конфигурации ──
    getClasses: (configId: string) =>
        get<{ config_id: string; classes: (ClassDef & { id: string })[] }>(`/neural/classes?config_id=${encodeURIComponent(configId)}`),
    getSuperclasses: (configId: string) =>
        get<{ config_id: string; superclasses: (SuperclassDef & { key: string })[] }>(`/neural/superclasses?config_id=${encodeURIComponent(configId)}`),

    getTrackerTypes: () => get<{ types: TrackerType[] }>('/neural/tracker-types'),

    getSystem: () => get<SystemInfo>('/neural/system'),

    getEventTypes: () => get<{ events: TrackEventType[] }>('/neural/event-types'),

    // ── Модели ──
    listModels: () => get<ModelFile[]>('/neural/models'),

    /** POST /neural/models?filename=*.rknn — тело это бинарь файла */
    uploadModel: (file: File) =>
        fetch(url(`/neural/models?filename=${encodeURIComponent(file.name)}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
        }).then(res => unwrap<ModelFile>(res)),

    // ── Камеры всех устройств (GET /api/cameras) ──
    listCameras: () => get<{ cameras: Record<string, CameraInfo> | null }>('/api/cameras'),
};
