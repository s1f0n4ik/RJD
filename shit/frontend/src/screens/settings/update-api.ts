import { useCallback, useEffect, useRef, useState } from 'react';
import { sameJson } from '../../utils/same-json';

// Обновление системы, как его отдаёт служба обновления мастера через /api/update

export type StepState = 'wait' | 'run' | 'ok' | 'fail' | 'back' | 'na';
export type StepId = 'delivery' | 'install' | 'master' | 'check';
export type RolloutPhase = 'delivery' | 'install' | 'master' | 'rollback' | 'done' | 'cancelled' | 'failed' | 'rolled_back';

export interface UpBoard {
    id: string;
    name: string;
    ip: string;
    online: boolean;
    // На плате отвечает служба обновления
    updater: boolean;
    master: boolean;
    roles: string[];
    version: string | null;
    prev: string | null;
    // Версия для показа: дата и время выпуска
    label: string | null;
    busy: boolean;
}

export interface UpCheck {
    level: 'ok' | 'warn' | 'err' | 'skip';
    title: string;
    detail: string;
}

export interface UpFile {
    name: string;
    size: number;
    size_label: string;
    uploaded: number;
    tag: string;
    label: string;
    base: string | null;
    base_label: string | null;
    kind: 'delta' | 'full';
    changed: number;
    total: number;
}

export interface UpRow {
    id: string;
    name: string;
    ip: string;
    roles: string[];
    master: boolean;
    skipped: boolean;
    steps: Record<StepId, StepState> | null;
    progress: { sent: number; total: number } | null;
    error: string | null;
    lost: boolean;
}

export interface UpEvent {
    t: number;
    text: string;
    level: '' | 'run' | 'ok' | 'err' | 'back';
}

export interface UpRollout {
    id: string;
    kind: 'update' | 'revert';
    phase: RolloutPhase;
    target: string | null;
    target_label: string;
    from: string | null;
    from_label: string;
    started: number;
    finished: number | null;
    boards: UpRow[];
    events: UpEvent[];
}

export interface UpState {
    system: { version: string | null; label: string; prev: string | null; prev_label: string | null };
    boards: UpBoard[];
    file: UpFile | null;
    checks: UpCheck[];
    rollout: UpRollout | null;
    pending: Array<{ id: string; name: string }>;
    busy: boolean;
    uploading: boolean;
    // Часы мастера, unix с: время хода считается по ним, часы браузера могут не совпадать
    now: number;
}

export interface UpLock {
    busy: boolean;
    phase: RolloutPhase | null;
    kind: 'update' | 'revert' | null;
}

// Ручки обновления проверяют роль на сервере: токен входа идёт в заголовке
const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
};

const errorText = (status: number, data: { detail?: string } | null) => data?.detail || `HTTP ${status}`;

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`/api/update${path}`, {
        method,
        headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(errorText(response.status, data));
    }
    return response.json() as Promise<T>;
}

// Файл в гигабайты: XHR даёт ход отправки, тело уходит потоком
function upload(file: File, onProgress: (sent: number) => void): Promise<UpState> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/update/file');
        Object.entries(authHeaders()).forEach(([key, value]) => xhr.setRequestHeader(key, value));
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
        xhr.upload.onprogress = e => onProgress(e.loaded);
        xhr.onload = () => {
            let data: (UpState & { detail?: string }) | null = null;
            try { data = JSON.parse(xhr.responseText); } catch { data = null; }
            if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
            else reject(new Error(errorText(xhr.status, data)));
        };
        xhr.onerror = () => reject(new Error('Связь с мастером прервалась'));
        xhr.send(file);
    });
}

export const updateApi = {
    state: () => call<UpState>('/state'),
    lock: () => call<UpLock>('/lock'),
    upload,
    remove: () => call<UpState>('/file', 'DELETE'),
    start: (confirm: boolean) => call<UpState>('/start', 'POST', { confirm }),
    cancel: () => call<UpState>('/cancel', 'POST'),
    revert: () => call<UpState>('/revert', 'POST'),
    boardLog: (id: string) => call<{ lines: string[] }>(`/board-log?id=${encodeURIComponent(id)}`),
};

// Состояние обновления с опросом: чаще, пока идёт обновление; при сбое остаются последние данные
export function useUpdateState(slowMs: number, fastMs: number) {
    const [state, setState] = useState<UpState | null>(null);
    const [failed, setFailed] = useState(false);
    const request = useRef(0);
    const applied = useRef(0);
    const busy = !!state?.busy;

    const load = useCallback(async () => {
        const token = ++request.current;
        try {
            const next = await updateApi.state();
            if (token < applied.current) return;
            applied.current = token;
            setState(previous => (sameJson(previous, next) ? previous : next));
            setFailed(false);
        } catch {
            if (token < applied.current) return;
            applied.current = token;
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), busy ? fastMs : slowMs);
        return () => window.clearInterval(timer);
    }, [load, busy, slowMs, fastMs]);

    // Ответ действия — уже свежий снимок, опроса не ждём
    const put = useCallback((next: UpState) => {
        applied.current = ++request.current;
        setState(next);
        setFailed(false);
    }, []);

    return { state, failed, put, reload: load };
}
