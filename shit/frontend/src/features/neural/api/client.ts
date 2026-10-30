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
    TrackEventType,
    TrackerType,
    VideoStream,
} from './types';
import { getDevices, getRouting, mcPath, moduleDeviceId } from '../../../services/devices';

// Пустая строка — тот же origin, прокси бэкенда ведёт на устройство модуля
export const API_HOST = '';

// Устройство подразделов техзрения: его ставит полоса «Устройство», без выбора — устройство по умолчанию
let selectedDevice: string | null = null;
export const setNeuralDevice = (id: string | null) => { selectedDevice = id; };
export const neuralDeviceId = (): string => selectedDevice ?? moduleDeviceId('neural');

// Ручки /neural/* идут на выбранное устройство или на явно переданное
const url = (path: string, device?: string) =>
    path.startsWith('/neural/') ? `${API_HOST}${mcPath(device ?? neuralDeviceId(), path)}` : `${API_HOST}${path}`;

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

const get = <T,>(path: string, device?: string): Promise<T> => fetch(url(path, device)).then(res => unwrap<T>(res));
const send = <T,>(path: string, method: string, body?: unknown): Promise<T> =>
    fetch(url(path), { method, headers: body === undefined ? undefined : jsonHeaders, body: body === undefined ? undefined : JSON.stringify(body) })
        .then(res => unwrap<T>(res));

// Конфигурацию техзрения хранит мастер: запись идёт в него с устройством подраздела
const master = (path: string, query: Record<string, string> = {}) =>
    `${API_HOST}/api${path}?${new URLSearchParams({ ...query, device: neuralDeviceId() })}`;

export const neuralApi = {
    // ── Конфигурации ──
    listConfigurations: (device?: string) => get<{ configurations: ConfigSummary[] }>('/neural/configurations', device),

    getConfiguration: (id: string, device?: string) => get<NeuralConfig>(`/neural/configurations?id=${encodeURIComponent(id)}`, device),

    /** POST /api/neural/configurations — { mode, data: { <id>: config } } */
    importConfigurations: (data: Record<string, NeuralConfig>, mode: ImportMode) =>
        send<unknown>(master('/neural/configurations'), 'POST', { mode, data }),

    /** DELETE /api/neural/configurations?id= — 409, если конфигурация занята слотом */
    deleteConfiguration: (id: string) => send<unknown>(master('/neural/configurations', { id }), 'DELETE'),

    // ── Видеопотоки ──
    listStreams: () => get<{ streams: VideoStream[] }>('/neural/streams'),

    /** POST /api/neural/streams — создать или заменить; без width/height размер берётся у модели конфигурации */
    saveStream: (stream: Partial<VideoStream> & { id: string }) => send<VideoStream>(master('/neural/streams'), 'POST', stream),

    /** DELETE /api/neural/streams?id= — 409, если поток занят слотом */
    deleteStream: (id: string) => send<unknown>(master('/neural/streams', { id }), 'DELETE'),

    // ── Состояние слотов ──
    getState: () => get<ActiveDesc[]>('/neural/state'),

    /** POST /api/neural/state — тело это массив дескрипторов напрямую */
    setState: (descs: ActiveDesc[]) => send<unknown>(master('/neural/state'), 'POST', descs),

    getStatus: () => get<SlotStatus[]>('/neural/status'),

    // ── Супервизор ──
    start: () => send<unknown>('/neural/start', 'POST'),
    restart: () => send<unknown>('/neural/restart', 'POST'),
    stop: () => send<unknown>('/neural/stop', 'POST'),

    // ── Классы и суперклассы конфигурации ──
    getClasses: (configId: string, device?: string) =>
        get<{ config_id: string; classes: (ClassDef & { id: string })[] }>(`/neural/classes?config_id=${encodeURIComponent(configId)}`, device),
    getSuperclasses: (configId: string, device?: string) =>
        get<{ config_id: string; superclasses: (SuperclassDef & { key: string })[] }>(`/neural/superclasses?config_id=${encodeURIComponent(configId)}`, device),

    getTrackerTypes: () => get<{ types: TrackerType[] }>(master('/neural/tracker-types')),

    getEventTypes: () => get<{ events: TrackEventType[] }>('/neural/event-types'),

    // ── Модели ──
    listModels: () => get<ModelFile[]>(master('/neural/models')),

    /** POST /api/neural/models?filename=*.rknn — тело это бинарь файла */
    uploadModel: (file: File) =>
        fetch(master('/neural/models', { filename: file.name }), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
        }).then(res => unwrap<ModelFile>(res)),

    // ── Камеры всех устройств (GET /api/cameras) ──
    listCameras: () => get<{ cameras: Record<string, CameraInfo> | null }>('/api/cameras'),
};

// Устройства с neural в сети, устройство по умолчанию первым
export function neuralDeviceIds(): string[] {
    const fallback = getRouting().neural;
    return getDevices()
        .filter(d => d.status === 'online' && d.modules.includes('neural'))
        .sort((a, b) => Number(b.id === fallback) - Number(a.id === fallback))
        .map(d => d.id);
}

export type DeviceConfig = ConfigSummary & { device: string };

// Конфигурации всех устройств; совпавший id берётся с первого ответившего по порядку neuralDeviceIds
export async function listAllConfigurations(): Promise<DeviceConfig[]> {
    const lists = await Promise.all(neuralDeviceIds().map(device =>
        neuralApi.listConfigurations(device)
            .then(r => r.configurations.map(c => ({ ...c, device })))
            .catch(() => [] as DeviceConfig[])));
    const byId = new Map<string, DeviceConfig>();
    for (const c of lists.flat()) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()];
}

// Классы и суперклассы конфигурации с устройства, где она есть
export async function configMeta(configId: string) {
    const found = (await listAllConfigurations()).find(c => c.id === configId);
    if (!found) throw new Error(`Configuration ${configId} not found on any device`);
    return Promise.all([neuralApi.getClasses(configId, found.device), neuralApi.getSuperclasses(configId, found.device)]);
}

// Полная конфигурация с устройства, где она есть: каталог зон и описание модели
export async function configFull(configId: string) {
    const found = (await listAllConfigurations()).find(c => c.id === configId);
    if (!found) throw new Error(`Configuration ${configId} not found on any device`);
    return neuralApi.getConfiguration(configId, found.device);
}
