import { useSyncExternalStore } from 'react';

// Состояние раздела 360 для точек в подсписке рельсы: поток калибровки идёт, вывод в эфире
export interface SurroundStatus {
    streaming: boolean;
    live: boolean;
}

let state: SurroundStatus = { streaming: false, live: false };
const listeners = new Set<() => void>();

export function setSurroundStatus(patch: Partial<SurroundStatus>) {
    const next = { ...state, ...patch };
    if (next.streaming === state.streaming && next.live === state.live) return;
    state = next;
    listeners.forEach(fn => fn());
}

export function useSurroundStatus(): SurroundStatus {
    return useSyncExternalStore(
        fn => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        () => state,
    );
}
