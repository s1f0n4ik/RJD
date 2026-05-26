// api/client.ts

import type { CPPCamera } from '../types';

const cameraUrl = (id: string) => `/api/camera/${encodeURIComponent(id)}`;

export interface CameraPatchBody {
    meta?: CameraMetaPatch;
    critical?: CameraCriticalPatch;
}

export interface CameraMetaPatch {
    display_name?: string;
    description?: string;
}

export interface CameraCriticalPatch {
    ip_adress?: string;
    port?: string;
    user?: string;
    password?: string; // ⚠️ включать в объект только при реальной смене
    production?: number;
    type?: number;
    streams?: {
        main: {
            sub: number;
            type: number;
            latency: number;
            use_udp: boolean;
            reconnect: number;
            record_path: string;
            segment: number;
        };
        sub: {
            sub: number;
            type: number;
            latency: number;
            use_udp: boolean;
            reconnect: number;
            record_path: string;
            segment: number;
        };
    };
}

// ── Контракт Media Center ──
interface CppError {
    code: number;
    message: string;
    details?: string;
}

interface CppResponse<T> {
    data: T | null;
    meta: unknown | null;
    error: CppError | null;
}

// Кастомный класс ошибки — чтобы в UI можно было различать
// сетевые сбои и доменные ошибки от C++.
export class MediaCenterError extends Error {
    readonly code: number;
    readonly details?: string;

    constructor(err: CppError) {
        super(err.details ? `${err.message}: ${err.details}` : err.message);
        this.name = 'MediaCenterError';
        this.code = err.code;
        this.details = err.details;
    }
}

class ApiClient {
    async getCameras(): Promise<CPPCamera[]> {
        const res = await this.fetch<{ cameras: Record<string, any> }>('/api/cameras');
        const camerasObj = res.cameras ?? {};
        return Object.entries(camerasObj).map(([key, raw]) =>
            this.normalize({ id: raw.id ?? key, ...raw })
        );
    }

    async getCamera(id: string): Promise<CPPCamera | null> {
        const res = await this.fetch<{ cameras: Record<string, any> }>(cameraUrl(id));
        const raw = res.cameras?.[id];
        return raw ? this.normalize({ id: raw.id ?? id, ...raw }) : null;
    }

    async createCamera(camera: CPPCamera) {
        return this.fetch('/api/camera', {
            method: 'POST',
            body: JSON.stringify(camera),
        });
    }

    async updateCamera(id: string, updates: CameraPatchBody) {
        if (!updates.meta && !updates.critical) return { ok: true, noop: true };
        return this.fetch(cameraUrl(id), {
            method: 'PATCH',
            body: JSON.stringify(updates),
        });
    }

    async deleteCamera(id: string): Promise<void> {
        await this.fetch(cameraUrl(id), { method: 'DELETE' });
    }

    // ── helpers ──

    /**
     * Унифицированный fetch для Media Center.
     * Раскладывает {data, meta, error} → возвращает data или кидает MediaCenterError.
     */
    private async fetch<T = unknown>(
        url: string,
        init: RequestInit = {}
    ): Promise<T> {
        const hasBody = init.body !== undefined;
        let r: Response;
        try {
            r = await window.fetch(url, {
                ...init,
                headers: {
                    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
                    ...init.headers,
                },
            });
        } catch (e) {
            // Сеть упала, nginx недоступен и т.п.
            throw new Error(`Network error: ${(e as Error).message}`);
        }

        // Пробуем распарсить тело — оно есть и при успехе, и при ошибке.
        const body = await r.json().catch(() => null) as CppResponse<T> | null;

        // Если есть error — кидаем его. Это работает и для 2xx (вдруг странный кейс),
        // и для 4xx/5xx.
        if (body?.error) {
            throw new MediaCenterError(body.error);
        }

        // На случай, если HTTP плохой, а тела с error нет (прокси упал, gateway timeout).
        if (!r.ok) {
            throw new Error(`${init.method ?? 'GET'} ${url} → HTTP ${r.status}`);
        }

        return body?.data as T;
    }

    private normalize(raw: any): CPPCamera {
        const id: string = raw.id ?? raw.name;
        return {
            ...raw,
            id,
            display_name: raw.display_name ?? raw.description ?? id,
        } as CPPCamera;
    }
}

export const api = new ApiClient();