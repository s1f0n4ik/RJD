import { useSyncExternalStore } from 'react';
import type { SlotStatus } from '../features/neural/api/types';

// Слоты техзрения по устройствам из GET /api/neural/status
export interface NeuralDeviceStatus {
    device_id: string;
    device_name: string;
    state: 'ok' | 'offline' | 'no_module';
    slots: SlotStatus[] | null;
}

// undefined — ответа ещё не было, null — мастер не ответил
type Snapshot = NeuralDeviceStatus[] | null | undefined;

const POLL_MS = 3000;

let snapshot: Snapshot = undefined;
let timer: number | undefined;
const listeners = new Set<() => void>();

/** Внеочередной опрос: после запуска, перезапуска и остановки слотов */
export async function refreshNeuralStatus() {
    try {
        const res = await fetch('/api/neural/status');
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json() as { data?: { devices?: NeuralDeviceStatus[] } };
        snapshot = json.data?.devices ?? [];
    } catch {
        snapshot = null;
    }
    listeners.forEach(fn => fn());
}

// Опрос идёт, пока статус кто-то показывает
function subscribe(fn: () => void) {
    listeners.add(fn);
    if (listeners.size === 1) {
        void refreshNeuralStatus();
        timer = window.setInterval(() => void refreshNeuralStatus(), POLL_MS);
    }
    return () => {
        listeners.delete(fn);
        if (!listeners.size) {
            window.clearInterval(timer);
            timer = undefined;
        }
    };
}

export const useNeuralStatus = (): Snapshot => useSyncExternalStore(subscribe, () => snapshot);
