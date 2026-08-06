/**
 * Реестр устройств и маршрутизация запросов.
 *
 * Мастер — чистый веб-стек; каждый media-center (со своим сигналингом и
 * storage-service) — отдельное устройство. Все обращения к устройству идут
 * через backend-прокси /d/{deviceId}/{service}/... — этот модуль строит пути.
 *
 * Кэш загружается при старте приложения (см. main.tsx) и обновляется
 * страницей настроек устройств.
 */

export interface DeviceTelemetry {
    hostname?: string;
    version?: string;
    uptime_sec?: number;
    platform?: { platform: string; label: string; mode: string; npu_cores: number; max_streams: number };
    cpu?: { cores: number; load_1: number; load_5: number; load_15: number; percent?: number };
    memory?: { total_bytes?: number; available_bytes?: number };
    temperature?: Array<{ zone: string; celsius: number }>;
    network?: Array<{ iface: string; rx_bytes: number; tx_bytes: number }>;
    disks?: Array<{ label: string; path: string; available: boolean; total_bytes?: number; free_bytes?: number }>;
}

export interface Device {
    id: string;
    ip: string;
    name: string;
    modules: string[];
    status: 'online' | 'offline' | 'unknown';
    last_seen: number | null;
    telemetry: DeviceTelemetry | null;
    // RTT опроса /system/info, считает backend
    ping_ms: number | null;
    // Скорость сети по дельтам счётчиков, считает backend
    net_rx_bps: number | null;
    net_tx_bps: number | null;
}

export interface RoutingTable {
    birdview: string | null;
    neural: string | null;
    /** ECameraType (число строкой) → deviceId */
    camera_types: Record<string, string | null>;
}

export interface ScanResult {
    id: string;
    ip: string;
    hostname?: string;
    version?: string;
    modules: string[];
    known: boolean;
}

// ── Кэш ──

let devicesCache: Device[] = [];
let routingCache: RoutingTable = { birdview: null, neural: null, camera_types: {} };

async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let detail = res.statusText;
        try {
            const body = await res.json();
            detail = body?.detail ?? body?.error ?? detail;
        } catch { /* тело не JSON */ }
        throw new Error(`${res.status} · ${detail}`);
    }
    return res.json() as Promise<T>;
}

export async function loadDevices(signal?: AbortSignal): Promise<{ devices: Device[]; routing: RoutingTable }> {
    const data = await fetch('/api/devices', { signal }).then(json<{ devices: Device[]; routing: RoutingTable }>);
    devicesCache = data.devices ?? [];
    routingCache = { birdview: null, neural: null, camera_types: {}, ...data.routing };
    return { devices: devicesCache, routing: routingCache };
}

export const getDevices = (): Device[] => devicesCache;
export const getRouting = (): RoutingTable => routingCache;

// ── Построение путей ──

const devicePath = (deviceId: string, service: 'mc' | 'storage' | 'signaling', path: string) =>
    `/d/${encodeURIComponent(deviceId)}/${service}${path.startsWith('/') ? path : `/${path}`}`;

/** REST media-center конкретного устройства: /d/{id}/mc/camera и т.п. */
export const mcPath = (deviceId: string, path: string) => devicePath(deviceId, 'mc', path);

/** storage-service конкретного устройства: записи, журнал, диск. */
export const storagePath = (deviceId: string, path: string) => devicePath(deviceId, 'storage', path);

/** WebSocket сигналинга устройства — с ws/wss по протоколу страницы. */
export const signalingWsUrl = (deviceId: string, path: string): string => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${devicePath(deviceId, 'signaling', path)}`;
};

/** Устройство, на которое таблица маршрутизации назначила модуль. */
export function moduleDeviceId(module: 'birdview' | 'neural'): string {
    const deviceId = routingCache[module];
    if (!deviceId) {
        throw new Error(`Модуль «${module}» не назначен ни одному устройству — настройте маршрутизацию`);
    }
    return deviceId;
}

/** REST media-center устройства, назначенного модулю: /linker/*, /neural/*. */
export const modulePath = (module: 'birdview' | 'neural', path: string) =>
    mcPath(moduleDeviceId(module), path);

/** Сигналинг устройства модуля birdview: потоки линкера, калибратор. */
export const birdviewSignalingUrl = (path: string) =>
    signalingWsUrl(moduleDeviceId('birdview'), path);

/** Устройство для создания камеры данного типа (ECameraType). */
export function deviceForCameraType(type: number): string {
    const deviceId = routingCache.camera_types?.[String(type)];
    if (!deviceId) {
        throw new Error(`Тип камеры ${type} не назначен ни одному устройству — настройте маршрутизацию`);
    }
    return deviceId;
}

// ── API страницы настроек ──

export const devicesApi = {
    load: loadDevices,

    scan(): Promise<{ found: ScanResult[] }> {
        return fetch('/api/devices/scan', { method: 'POST' }).then(json);
    },

    async add(device: { id: string; ip: string; name: string; modules: string[] }): Promise<void> {
        await fetch('/api/devices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(device),
        }).then(json);
        await loadDevices();
    },

    async rename(deviceId: string, name: string): Promise<void> {
        await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        }).then(json);
        await loadDevices();
    },

    async remove(deviceId: string): Promise<void> {
        await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }).then(json);
        await loadDevices();
    },

    async saveRouting(routing: RoutingTable): Promise<void> {
        await fetch('/api/devices/routing', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(routing),
        }).then(json);
        await loadDevices();
    },
};
