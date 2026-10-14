import { useCallback, useEffect, useState } from 'react';
import { storagePath, type Device } from '../../services/devices';

// Пул дисков записи устройства, как его отдаёт storage-service

export interface PoolVolume {
    id: string;
    internal: boolean;
    // Имя для показа: своё, метка ФС или «Диск N»
    name: string;
    custom_name: string;
    enabled: boolean;
    high: number;
    low: number;
    path: string | null;
    state: 'online' | 'offline' | 'readonly';
    writing: boolean;
    // Последний раз виден подключённым, unix ms
    seen_ms: number | null;
    total_bytes: number | null;
    used_bytes: number | null;
    free_bytes: number | null;
    // Записи этого устройства на томе
    records_bytes: number;
    segment_count: number;
    first_ms: number | null;
    last_ms: number | null;
}

// ok — пишем; ring — весь набор у порогов, удаляются старые; stuck — писать некуда
export type PoolState = 'ok' | 'ring' | 'stuck';

export interface Pool {
    device_id: string | null;
    volumes: PoolVolume[];
    unsuitable: Array<{ path: string; fstype: string; reason: 'fs' | 'marker' }>;
    summary: {
        state: PoolState;
        total_bytes: number;
        used_bytes: number;
        free_bytes: number;
        records_bytes: number;
        journal_bytes: number;
        journal_reserve_bytes: number;
        disk_count: number;
        writing: string | null;
        offline: string[];
    };
}

export type VolumePatch = Partial<{ name: string; enabled: boolean; high: number; low: number }>;

// Страховка media-center: выше этого он не пишет
export const STOP_PERCENT = 99;
export const MIN_HIGH = 50;
export const MAX_HIGH = 98;
export const MIN_GAP = 5;

// 1 диск · 3 диска · 5 дисков; внешних нет — «без дисков»
export function disksLabel(n: number): string {
    if (!n) return 'без дисков';
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return `${n} диск`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} диска`;
    return `${n} дисков`;
}

async function call<T>(deviceId: string, path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(storagePath(deviceId, `/api${path}`), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(data?.detail || `HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
}

const vol = (id: string) => `/storage/volumes/${encodeURIComponent(id)}`;

export const poolApi = {
    get: (deviceId: string) => call<Pool>(deviceId, '/storage/pool'),
    update: (deviceId: string, id: string, patch: VolumePatch) => call<Pool>(deviceId, vol(id), 'PATCH', patch),
    reorder: (deviceId: string, ids: string[]) => call<Pool>(deviceId, '/storage/order', 'PUT', { ids }),
    forget: (deviceId: string, id: string) => call<{ removed: number }>(deviceId, vol(id), 'DELETE'),
    foreign: (deviceId: string, id: string) =>
        call<{ devices: Array<{ device_id: string; bytes: number }> }>(deviceId, `${vol(id)}/foreign`),
    clearForeign: (deviceId: string, id: string, owner: string) =>
        call<{ ok: boolean }>(deviceId, `${vol(id)}/foreign/${encodeURIComponent(owner)}`, 'DELETE'),
};

/** Пулы всех устройств: ключ — id устройства, null — служба хранения не ответила. */
export function usePools(devices: Device[], pollMs: number) {
    const [pools, setPools] = useState<Record<string, Pool | null>>({});

    const ids = devices.map(d => d.id).join(',');

    const load = useCallback(async () => {
        if (!ids) return;
        const entries = await Promise.all(ids.split(',').map(async id =>
            [id, await poolApi.get(id).catch(() => null)] as const));
        setPools(Object.fromEntries(entries));
    }, [ids]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), pollMs);
        return () => window.clearInterval(timer);
    }, [load, pollMs]);

    // Ответ правки — уже свежий снимок, опроса не ждём
    const put = useCallback((deviceId: string, pool: Pool) => {
        setPools(prev => ({ ...prev, [deviceId]: pool }));
    }, []);

    return { pools, put, reload: load };
}
