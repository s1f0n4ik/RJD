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
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'LinkerError';
        this.status = status;
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
    rotation: Rotation;
    viewMode: ViewMode;
    /**
     * Размер кадра в эфире. Шире канваса: стороны округляются вверх под
     * кодек, и картинка на эту разницу растягивается. Нули — вывод не
     * запускался.
     */
    width: number;
    height: number;
}

/** Привязка «ключ позиции → id камеры». */
export type LinkerBindings = Record<string, string>;

/** Допустимые углы поворота вывода, против часовой. */
export const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];

/** Режим вывода: сшивка сверху или объёмный вид. */
export type ViewMode = 'top' | 'surround';

/** Габарит машины в метрах. */
export interface SurroundMachine {
    length: number;
    width: number;
    height: number;
}

/** Отступы чаши от борта в долях от меньшей стороны габарита. */
export interface SurroundBowl {
    floor: number;
    outer: number;
    wall: number;
    plate: number;
    blend: number;
}

export interface SurroundOrbit {
    distance: number;
    height: number;
    speed: number;
}

/** Размеры модели в метрах; 0 — размер габарита. */
export interface SurroundModel {
    length: number;
    width: number;
    height: number;
    alpha: number;
}

/** Действующая поза камеры из печки: метры от центра габарита и градусы. */
export interface SurroundCameraPose {
    placeKey: string;
    cameraId: string;
    source: 'pnp' | 'manual';
    height: number;
    reprojectionError: number;
    position: [number, number, number];
    yaw: number;
    pitch: number;
    roll: number;
}

export interface SurroundConfig {
    machine: SurroundMachine;
    bowl: SurroundBowl;
    orbit: SurroundOrbit;
    model: SurroundModel;
    plate: boolean;
    wireframe: boolean;
    photometric: boolean;
    cameras: SurroundCameraPose[];
}

/** Частичное обновление surround-блока: только изменившиеся поля. */
export interface SurroundPatch {
    machine?: Partial<SurroundMachine>;
    bowl?: Partial<SurroundBowl>;
    orbit?: Partial<SurroundOrbit>;
    model?: Partial<SurroundModel>;
    plate?: boolean;
    wireframe?: boolean;
    photometric?: boolean;
}

/** Параметры запуска. Свои у каждой конфигурации. */
export interface LinkerParams {
    fps: number;
    streamId: string;
    streamName: string;
    /**
     * Поворот вывода против часовой. Меняет размер кадра при 90 и 270,
     * поэтому применяется только через перезапуск вывода.
     */
    rotation: Rotation;
    /** Режим вывода. Живой применяется через перезапуск своей ручкой. */
    viewMode: ViewMode;
}

/** Место камеры на канвасе: прямоугольник, посчитанный сервером при экспорте. */
export interface LinkerPlace {
    key: string;
    /** Имя места из пресета. По нему оператор понимает, куда ставить камеру. */
    name: string;
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
    /** Угол, с которым конфигурация пойдёт в эфир. Считает сервер. */
    rotation: Rotation;
}

/** Значение из json к допустимому углу. Всё непонятное — 0. */
function normalizeRotation(value: unknown): Rotation {
    const n = Number(value);
    return (ROTATIONS as readonly number[]).includes(n) ? (n as Rotation) : 0;
}

/** Значение из json к режиму вывода. Всё непонятное — top. */
function normalizeViewMode(value: unknown): ViewMode {
    return value === 'surround' ? 'surround' : 'top';
}

function num(value: unknown, def: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
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
            // Записи, сделанные до появления имени, показываются по ключу
            name: typeof cam?.name === 'string' && cam.name ? cam.name : key,
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
            rotation: normalizeRotation(data.rotation),
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
            rotation: normalizeRotation(data.rotation),
            viewMode: normalizeViewMode(data.view_mode),
            width: Number(data.width) || 0,
            height: Number(data.height) || 0,
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
                    ...(entry.rotation != null ? { rotation: normalizeRotation(entry.rotation) } : {}),
                    ...(entry.view_mode ? { viewMode: normalizeViewMode(entry.view_mode) } : {}),
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
            rotation: params.rotation,
        });
    },

    /**
     * Поворот вывода отдельной ручкой: он свойство картинки, а не настроек
     * одной страницы, и менять его нужно не только отсюда. Живую конфигурацию
     * сервер пересобирает сам — размер кадра при 90 и 270 другой.
     */
    async setRotation(rotation: Rotation, exportId?: string): Promise<void> {
        await fetchJson('POST', '/linker/rotation', {
            rotation,
            ...(exportId ? { export_id: exportId } : {}),
        });
    },

    /**
     * Режим вывода отдельной ручкой, как поворот: сервер сам перезапускает
     * живой вывод — размер кадра и пайплайн у режимов разные.
     */
    async setViewMode(mode: ViewMode, exportId?: string): Promise<void> {
        await fetchJson('POST', '/linker/view-mode', {
            view_mode: mode,
            ...(exportId ? { export_id: exportId } : {}),
        });
    },

    /** Действующие настройки объёмного вида с печёными позами камер. */
    async getSurround(exportId?: string): Promise<SurroundConfig> {
        const path = exportId
            ? `/linker/surround?id=${encodeURIComponent(exportId)}`
            : '/linker/surround';
        const json = await fetchJson<any>('GET', path);
        const d = json.data ?? json;
        const machine = d.machine ?? {};
        const bowl = d.bowl ?? {};
        const orbit = d.orbit ?? {};
        const model = d.model ?? {};

        const cameras: SurroundCameraPose[] = (Array.isArray(d.cameras) ? d.cameras : [])
            .map((c: any): SurroundCameraPose => ({
                placeKey: String(c.place_key ?? ''),
                cameraId: String(c.camera_id ?? ''),
                source: c.source === 'manual' ? 'manual' : 'pnp',
                height: num(c.height, 0),
                reprojectionError: num(c.reprojection_error, 0),
                position: [
                    num(c.position?.[0], 0),
                    num(c.position?.[1], 0),
                    num(c.position?.[2], 0),
                ],
                yaw: num(c.yaw, 0),
                pitch: num(c.pitch, 0),
                roll: num(c.roll, 0),
            }))
            .filter((c: SurroundCameraPose) => c.placeKey);

        return {
            machine: {
                length: num(machine.length, 0),
                width: num(machine.width, 0),
                height: num(machine.height, 0),
            },
            bowl: {
                floor: num(bowl.floor, 0.9),
                outer: num(bowl.outer, 2.3),
                wall: num(bowl.wall, 0.9),
                plate: num(bowl.plate, 1.5),
                blend: num(bowl.blend, 0.3),
            },
            orbit: {
                distance: num(orbit.distance, 3.4),
                height: num(orbit.height, 2.0),
                speed: num(orbit.speed, 0.25),
            },
            model: {
                length: num(model.length, 0),
                width: num(model.width, 0),
                height: num(model.height, 0),
                alpha: num(model.alpha, 1),
            },
            plate: d.plate !== false,
            wireframe: d.wireframe === true,
            photometric: d.photometric !== false,
            cameras,
        };
    },

    /** Частичный мёрж surround-блока. Живой вывод применяет без рестарта. */
    async postSurround(patch: SurroundPatch, exportId?: string): Promise<void> {
        await fetchJson('POST', '/linker/surround', {
            ...patch,
            ...(exportId ? { export_id: exportId } : {}),
        });
    },

    /** Ручная поза камеры места либо сброс к вычисленной PnP. */
    async setSurroundCamera(
        placeKey: string,
        pose:
            | { position: [number, number, number]; yaw: number; pitch: number; roll: number }
            | { reset: true },
        exportId?: string,
    ): Promise<void> {
        await fetchJson('POST', '/linker/surround-camera', {
            place_key: placeKey,
            ...pose,
            ...(exportId ? { export_id: exportId } : {}),
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
