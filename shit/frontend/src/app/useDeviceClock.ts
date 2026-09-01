/**
 * Единое время изделия.
 *
 * Время приходит по шине в message-gateway, тот отдаёт снимок уже сдвинутым
 * на настроенный пояс; бэкенд проксирует его как GET /api/time. Здесь один
 * опрос на всё приложение: держим дельту к локальным часам, тикаем сами,
 * сверяемся раз в минуту. Два источника времени в интерфейсе недопустимы —
 * поэтому store модульный, а не по хуку на экран.
 */

import { useEffect, useState } from 'react';

// Откуда взято время: шина Садко или собственные часы шлюза
export type TimeSource = 'can' | 'server';

export interface DeviceClock {
    /** Время изделия в миллисекундах, уже в поясе; null — шлюз недоступен */
    unixMs: number | null;
    source: TimeSource | null;
}

const SYNC_INTERVAL_MS = 60_000;
const TICK_INTERVAL_MS = 1000;

// Дельта к локальным часам: складывается с Date.now() между сверками
let deltaMs: number | null = null;
let source: TimeSource | null = null;

const listeners = new Set<() => void>();
let syncTimer: number | null = null;

function notify(): void {
    listeners.forEach(fn => fn());
}

async function sync(): Promise<void> {
    try {
        const res = await fetch('/api/time');
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const unixMs = Number(data?.unix_ms);
        if (!Number.isFinite(unixMs)) throw new Error('bad unix_ms');

        deltaMs = unixMs - Date.now();
        source = data?.source?.time === 'can' ? 'can' : 'server';
    } catch {
        // Своё время не подставляем: интерфейс покажет прочерк
        deltaMs = null;
        source = null;
    }
    notify();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    if (syncTimer === null) {
        sync();
        syncTimer = window.setInterval(sync, SYNC_INTERVAL_MS);
    }
    return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && syncTimer !== null) {
            window.clearInterval(syncTimer);
            syncTimer = null;
        }
    };
}

export function useDeviceClock(): DeviceClock {
    const [, forceTick] = useState(0);

    useEffect(() => {
        const unsub = subscribe(() => forceTick(v => v + 1));
        const tick = window.setInterval(() => forceTick(v => v + 1), TICK_INTERVAL_MS);
        return () => {
            unsub();
            window.clearInterval(tick);
        };
    }, []);

    return {
        unixMs: deltaMs === null ? null : Date.now() + deltaMs,
        source,
    };
}

// Снимок уже сдвинут на пояс изделия — форматируем как UTC, иначе браузер
// добавит свой пояс вторым слоем
const TIME_FMT: Intl.DateTimeFormatOptions = {
    timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit',
};

const DATE_FMT: Intl.DateTimeFormatOptions = {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
};

export function formatDeviceTime(unixMs: number | null): string {
    if (unixMs === null) return '—';
    return new Date(unixMs).toLocaleTimeString('ru-RU', TIME_FMT);
}

export function formatDeviceDate(unixMs: number | null): string {
    if (unixMs === null) return '—';
    return new Date(unixMs).toLocaleDateString('ru-RU', DATE_FMT);
}
