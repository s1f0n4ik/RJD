/**
 * REST-клиент линкера. Порт api.js и linker-data.js из no-react.
 *
 * Ответы media-center приходят как { data: ... }, но часть ручек исторически
 * отдаёт полезную нагрузку и в корне — поэтому везде разбор через `?? `.
 */

async function fetchJson<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
): Promise<T> {
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
        // Сообщение сервера ценнее кода: отказ удалить запущенную конфигурацию
        // приходит текстом, и показать его надо как есть
        const text = await res.text().catch(() => '');
        let reason = text;
        try {
            const parsed = JSON.parse(text);
            reason = parsed.error ?? parsed.description ?? parsed.message ?? text;
        } catch {
            // Ответ не json — берём тело целиком
        }
        throw new LinkerError(res.status, reason || `${res.status}`);
    }
    return res.json() as Promise<T>;
}

/** Отказ REST-ручки. status нужен, чтобы отличить конфликт от неверного запроса. */
export class LinkerError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'LinkerError';
    }
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
    streamName: string;
    fps: number;
}

/** Привязка «ключ позиции → id камеры». */
export type LinkerBindings = Record<string, string>;

/** Параметры запуска. Свои у каждой конфигурации. */
export interface LinkerParams {
    fps: number;
    streamId: string;
    streamName: string;
}

/** Место камеры на канвасе: прямоугольник, посчитанный сервером при экспорте. */
export interface LinkerPlace {
    key: string;
    /** null — запись сделана до появления region, схему по ней не построить. */
    rect: { x: number; y: number; w: number; h: number } | null;
}

/** Подложка схемы: картинка конфигурации с её местом на канвасе. */
export interface LinkerOverlay {
    name: string;
    rect: { x: number; y: number; w: number; h: number };
}

/** Полная запись конфигурации — источник для схемы назначения. */
export interface LinkerExportDetail {
    id: string;
    name: string;
    canvas: { width: number; height: number };
    places: LinkerPlace[];
    images: LinkerOverlay[];
}

function toRect(v: unknown): { x: number; y: number; w: number; h: number } | null {
    if (!Array.isArray(v) || v.length < 4) return null;
    const [x, y, w, h] = v.map(Number);
    if ([x, y, w, h].some(n => !Number.isFinite(n)) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
}

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

    /** Полная запись конфигурации: канвас, места камер и подложки. */
    async getExport(exportId: string): Promise<LinkerExportDetail> {
        const json = await fetchJson<any>('GET', `/linker/export?id=${encodeURIComponent(exportId)}`);
        const data = json.data ?? json;

        const places: LinkerPlace[] = Object.entries<any>(data.cameras ?? {}).map(([key, cam]) => ({
            key,
            rect: toRect(cam?.region),
        }));

        const images: LinkerOverlay[] = (Array.isArray(data.images) ? data.images : [])
            .map((img: any) => ({ name: String(img?.name ?? ''), rect: toRect(img?.rect) }))
            .filter((img: any): img is LinkerOverlay => img.rect !== null);

        return {
            id: exportId,
            name: data.name ?? exportId,
            canvas: {
                width: Number(data.width) || 0,
                height: Number(data.height) || 0,
            },
            places,
            images,
        };
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
            streamName: data.stream_name ?? '',
            fps: Number(data.fps) || 0,
        };
    },

    /**
     * Сохранённые привязки и параметры конфигурации.
     * Состояние — словарь по export_id, поэтому берётся запись нужной.
     */
    async getStateFor(
        exportId: string,
    ): Promise<{ bindings: LinkerBindings; params: Partial<LinkerParams> }> {
        try {
            const json = await fetchJson<any>('GET', '/linker/state');
            const st = json.data ?? json;
            const entry = st?.configs?.[exportId];
            if (!entry) return { bindings: {}, params: {} };

            const bindings: LinkerBindings = {};
            for (const [key, value] of Object.entries<any>(entry.cameras ?? {})) {
                if (typeof value === 'string' && value) bindings[key] = value;
            }

            return {
                bindings,
                params: {
                    ...(entry.fps ? { fps: Number(entry.fps) } : {}),
                    ...(entry.stream_id ? { streamId: String(entry.stream_id) } : {}),
                    ...(entry.stream_name ? { streamName: String(entry.stream_name) } : {}),
                },
            };
        } catch {
            // Состояния нет — это нормально для конфигурации, которую не запускали
        }
        return { bindings: {}, params: {} };
    },

    async saveState(
        exportId: string,
        bindings: LinkerBindings,
        params: LinkerParams,
    ): Promise<void> {
        await fetchJson('POST', '/linker/state', {
            export_id: exportId,
            cameras: bindings,
            fps: params.fps,
            stream_id: params.streamId,
            stream_name: params.streamName,
        });
    },

    /** Удаляет запись, каталог карт и настройки. Отменить нельзя. */
    async deleteExport(exportId: string): Promise<void> {
        await fetchJson('DELETE', `/linker/export?id=${encodeURIComponent(exportId)}`);
    },

    async start(): Promise<void> {
        await fetchJson('POST', '/linker/start');
    },

    async stop(): Promise<void> {
        await fetchJson('POST', '/linker/stop');
    },
};
