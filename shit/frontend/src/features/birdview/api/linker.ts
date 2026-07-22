/**
 * REST-клиент линкера. Порт api.js и linker-data.js из no-react.
 *
 * Ответы media-center приходят как { data: ... }, но часть ручек исторически
 * отдаёт полезную нагрузку и в корне — поэтому везде разбор через `?? `.
 */

async function fetchJson<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const opts: RequestInit = {
        method,
        headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
        opts.headers = { ...opts.headers, 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
    }

    const res = await fetch(path, opts);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path}: ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
}

/** Конфигурация stitching, сохранённая конфигуратором. */
export interface LinkerExport {
    id: string;
    name?: string;
    /** Ключи позиций камер — то, что в конфигураторе задано полем «Ключ». */
    cameras?: string[];
}

/** Камера, пригодная для birdview (type === 3). */
export interface LinkerCamera {
    id: string;
    display_name: string;
}

export interface LinkerStatus {
    running: boolean;
    /** Пустой, пока processing_loop не дошёл до присвоения. */
    streamId: string | null;
    exportId: string | null;
}

/** Привязка «ключ позиции → id камеры». */
export type LinkerBindings = Record<string, string>;

export const linkerApi = {
    async getExports(): Promise<LinkerExport[]> {
        const json = await fetchJson<any>('GET', '/linker/exports');
        return json.data?.exports ?? json.exports ?? [];
    },

    /** Только камеры type === 3 — остальные для birdview не годятся. */
    async getCameras(): Promise<LinkerCamera[]> {
        const json = await fetchJson<any>('GET', '/api/camera');
        const all = json.data?.cameras ?? {};
        return Object.entries<any>(all)
            .filter(([, c]) => c.type === 3)
            .map(([id, c]) => ({ id, display_name: c.display_name ?? id }));
    },

    async getStatus(): Promise<LinkerStatus> {
        const json = await fetchJson<any>('GET', '/linker/status');
        const data = json.data ?? json;
        const streamId = data.stream_id ?? null;
        return {
            running: Boolean(data.running),
            // Бэкенд отдаёт пустую строку, пока стрим не поднялся
            streamId: streamId ? String(streamId) : null,
            exportId: data.export_id ?? null,
        };
    },

    /** Сохранённая привязка для конфигурации. Пусто, если её ещё не сохраняли. */
    async getStateFor(exportId: string): Promise<LinkerBindings> {
        try {
            const json = await fetchJson<any>('GET', '/linker/state');
            const st = json.data ?? json;
            if (st.export_id === exportId && st.cameras) return { ...st.cameras };
        } catch {
            // Состояния нет — это нормально для конфигурации, которую не запускали
        }
        return {};
    },

    async saveState(exportId: string, bindings: LinkerBindings): Promise<void> {
        await fetchJson('POST', '/linker/state', { export_id: exportId, cameras: bindings });
    },

    async start(): Promise<void> {
        await fetchJson('POST', '/linker/start');
    },

    async stop(): Promise<void> {
        await fetchJson('POST', '/linker/stop');
    },
};
