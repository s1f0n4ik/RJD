import { useSyncExternalStore } from 'react';
import { libraryApi, type RuntimeSnapshot } from './library-api';

// snapshot — последний принятый снимок мастера, failed — мастер не ответил (снимок остаётся прежним)
interface RuntimeStore {
    snapshot: RuntimeSnapshot | null;
    failed: boolean;
}

const WAIT_S = 20;
const RETRY_MS = 2500;
let store: RuntimeStore = { snapshot: null, failed: false };
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

const publish = (next: RuntimeStore) => {
    store = next;
    listeners.forEach((listener) => listener());
};

const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            window.clearTimeout(timer);
            resolve();
        });
    });

// Ответ ждёт на мастере изменения после since; снимок старее принятого отбрасывается
async function follow(signal: AbortSignal) {
    let boot: string | undefined;
    let since: number | undefined;
    while (!signal.aborted) {
        try {
            const snapshot = await libraryApi.runtime(boot, since, WAIT_S, signal);
            if (signal.aborted) return;
            const current = store.snapshot;
            const fresh = !current || snapshot.boot !== current.boot || snapshot.seq >= current.seq;
            publish({ snapshot: fresh ? snapshot : current, failed: false });
            boot = snapshot.boot;
            since = snapshot.seq;
        } catch {
            if (signal.aborted) return;
            publish({ ...store, failed: true });
            await pause(RETRY_MS, signal);
        }
    }
}

// Опрос идёт, пока снимок кто-то показывает
function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        controller = new AbortController();
        void follow(controller.signal);
    }
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            controller?.abort();
            controller = null;
        }
    };
}

export const useRuntimeState = (): RuntimeStore => useSyncExternalStore(subscribe, () => store);
