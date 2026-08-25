// api/client.ts

import type {
  CPPCamera,
  NeuralConfigurationBody,
  NeuralConfigurationListItem,
  NeuralRuntimeStatusItem,
  NeuralStateItem,
  ProbeRequest,
  ProbeResult,
  StreamProducer,
  StreamPurpose,
  VirtualStream,
} from '../types';

import { mcPath, modulePath } from './devices';

// REST media-center устройства-владельца: /camera?id=... (как раньше делал nginx)
const cameraUrl = (deviceId: string, id: string) =>
    mcPath(deviceId, `/camera?id=${encodeURIComponent(id)}`);

export interface CameraPatchBody {
    meta?: CameraMetaPatch;
    critical?: CameraCriticalPatch;
}

export interface CameraMetaPatch {
    display_name?: string;
    description?: string;
}

export interface CameraStreamPatch {
    channel: number;
    substream: number;
    purposes: StreamPurpose[];
    latency: number;
    use_udp: boolean;
    reconnect: number;
    record_path: string;
    segment: number;
}

export interface CameraCriticalPatch {
    ip_adress?: string;
    port?: string;
    user?: string;
    password?: string; // ⚠️ включать в объект только при реальной смене
    production?: number;
    // Ключи — stream_1…stream_N; PATCH задаёт набор потоков целиком
    streams?: Record<string, CameraStreamPatch>;
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
        const { cameras } = await this.getSources();
        return cameras;
    }

    // Камеры и виртуальные потоки одним ответом
    async getSources(): Promise<{ cameras: CPPCamera[]; virtual: VirtualStream[] }> {
        const res = await this.fetch<{
            cameras: Record<string, any> | null;
            virtual?: any[] | null;
        }>('/api/cameras');

        const camerasObj = res.cameras ?? {};
        return {
            cameras: Object.entries(camerasObj).map(([key, raw]) =>
                this.normalize({ id: raw.id ?? key, ...raw })
            ),
            virtual: (res.virtual ?? []).map(raw => this.normalizeStream(raw)),
        };
    }

    // Только потоки, без списка камер
    async getVirtualStreams(): Promise<VirtualStream[]> {
        const res = await this.fetch<any[]>('/api/streams');
        return (res ?? []).map(raw => this.normalizeStream(raw));
    }

    async getCamera(id: string, deviceId: string): Promise<CPPCamera | null> {
        const res = await this.fetch<{ cameras: Record<string, any> }>(cameraUrl(deviceId, id));
        const raw = res.cameras?.[id];
        return raw ? this.normalize({ id: raw.id ?? id, ...raw }) : null;
    }

    // Устройство-владелец выбирает оператор: выводить его больше не из чего
    async createCamera(camera: CPPCamera, deviceId: string) {
        return this.fetch(mcPath(deviceId, '/camera'), {
            method: 'POST',
            body: JSON.stringify(camera),
        });
    }

    async updateCamera(id: string, updates: CameraPatchBody, deviceId: string) {
        if (!updates.meta && !updates.critical) return { ok: true, noop: true };
        return this.fetch(cameraUrl(deviceId, id), {
            method: 'PATCH',
            body: JSON.stringify(updates),
        });
    }

    async deleteCamera(id: string, deviceId: string): Promise<void> {
        await this.fetch(cameraUrl(deviceId, id), { method: 'DELETE' });
    }

    /**
     * Проверка одного потока камеры. Камера не создаётся и в конфиг не
     * попадает; отказ приходит как result:"error" с причиной, а не исключением.
     */
    async probeStream(deviceId: string, body: ProbeRequest): Promise<ProbeResult> {
        return this.fetch<ProbeResult>(mcPath(deviceId, '/probe'), {
            method: 'POST',
            body: JSON.stringify(body),
        });
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

    private normalizeStream(raw: any): VirtualStream {
        const id = String(raw?.id ?? '');
        // Неизвестный продюсер считается нейронным
        const producer: StreamProducer = raw?.producer === 'birdview' ? 'birdview' : 'neural';
        return {
            id,
            // Пустое имя подменяет экран, не клиент API
            name: String(raw?.name ?? ''),
            producer,
            source_id: String(raw?.source_id ?? ''),
            source_name: String(raw?.source_name ?? ''),
            cameras: Array.isArray(raw?.cameras) ? raw.cameras.map(String) : [],
            width: Number(raw?.width) || 0,
            height: Number(raw?.height) || 0,
            running: Boolean(raw?.running),
            device_id: raw?.device_id ? String(raw.device_id) : undefined,
            device_name: raw?.device_name ? String(raw.device_name) : undefined,
            offline: raw?.offline === true ? true : undefined,
        };
    }

        // ---------- Neural API (raw JSON, не CppResponse) ----------

    private async fetchRaw<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
        // Ручки нейронки живут на устройстве, назначенном модулю neural
        if (url.startsWith('/neural/')) {
            url = modulePath('neural', url);
        }
        const hasBody = init.body !== undefined;
        const r = await window.fetch(url, {
            ...init,
            headers: {
                ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
                ...init.headers,
            },
        });

        if (!r.ok) {
            throw new Error(`${init.method ?? 'GET'} ${url} → HTTP ${r.status}`);
        }

        if (r.status === 204) return null as T;
        return (await r.json()) as T;
    }

    // добавь хелпер в ApiClient
    private unwrapNeural<T = any>(payload: any): T {
      // поддержка и raw-json, и {data: ...}
      if (payload && typeof payload === 'object' && 'data' in payload) {
        return payload.data as T;
      }
      return payload as T;
    }

    async getNeuralConfigurations(): Promise<NeuralConfigurationListItem[]> {
      const raw = await this.fetchRaw<any>('/neural/configurations');
      const data = this.unwrapNeural<any>(raw);

      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.configurations)) return data.configurations;
      return [];
    }

    async getNeuralConfigurationById(id: string): Promise<NeuralConfigurationBody> {
      const raw = await this.fetchRaw<any>(`/neural/configurations?id=${encodeURIComponent(id)}`);
      const data = this.unwrapNeural<any>(raw);

      if (data && typeof data === 'object' && data[id]) return data[id] as NeuralConfigurationBody;
      return data as NeuralConfigurationBody;
    }

    async getNeuralState(): Promise<NeuralStateItem[]> {
      const raw = await this.fetchRaw<any>('/neural/state');
      const data = this.unwrapNeural<any>(raw);
      return Array.isArray(data) ? data : [];
    }

    async getNeuralStatus(): Promise<NeuralRuntimeStatusItem[]> {
      const raw = await this.fetchRaw<any>('/neural/status');
      const data = this.unwrapNeural<any>(raw);
      return Array.isArray(data) ? data : [];
    }

    async postNeuralState(payload: NeuralStateItem[]): Promise<void> {
        await this.fetchRaw('/neural/state', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    }

    async postNeuralConfigurations(mode: 'merge' | 'replace', data: any): Promise<void> {
        await this.fetchRaw('/neural/configurations', {
            method: 'POST',
            body: JSON.stringify({ mode, data }),
        });
    }

    async postNeuralStart(): Promise<void> {
        await this.fetchRaw('/neural/start', { method: 'POST' });
    }

    async postNeuralStop(): Promise<void> {
        await this.fetchRaw('/neural/stop', { method: 'POST' });
    }

    async postNeuralRestart(): Promise<void> {
        await this.fetchRaw('/neural/restart', { method: 'POST' });
    }
}

export const api = new ApiClient();