import { useSyncExternalStore } from 'react';

// Состояние технического зрения для точки у «Потоков» в рельсе: есть работающий слот, есть слот с ошибкой
export interface NeuralStatus {
    running: boolean;
    failed: boolean;
}

let state: NeuralStatus = { running: false, failed: false };
const listeners = new Set<() => void>();

export function setNeuralStatus(patch: Partial<NeuralStatus>) {
    const next = { ...state, ...patch };
    if (next.running === state.running && next.failed === state.failed) return;
    state = next;
    listeners.forEach(fn => fn());
}

export function useNeuralStatus(): NeuralStatus {
    return useSyncExternalStore(
        fn => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        () => state,
    );
}
