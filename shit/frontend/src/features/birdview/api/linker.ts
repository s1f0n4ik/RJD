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
    /** Есть рект габарита или картинка. Без них открыть в линкере нельзя. */
    valid: boolean;
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

/**
 * Пропорции чаши в долях от меньшей стороны габарита: дно от борта,
 * вынос стенки от конца дна, скругление углов (0 — прямоугольник).
 */
export interface SurroundBowl {
    floor: number;
    outer: number;
    wall: number;
    plate: number;
    blend: number;
    corner: number;
}

export interface SurroundOrbit {
    distance: number;
    height: number;
    speed: number;
    /** Дефолт ручного вращения: с ним вывод стартует без автооблёта. */
    interactive: boolean;
}

/** Размеры модели в метрах; 0 — размер габарита. */
export interface SurroundModel {
    length: number;
    width: number;
    height: number;
    alpha: number;
    /** Поворот вокруг вертикали, градусы. */
    rotation: number;
    /** Файл .glb из библиотеки моделей; пусто — параллелепипед. */
    source: string;
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
    /** Расчётная PnP-база: к ней откатываются отдельные поля формы. */
    pnp: {
        position: [number, number, number];
        yaw: number;
        pitch: number;
        roll: number;
    };
}

export interface SurroundConfig {
    machine: SurroundMachine;
    bowl: SurroundBowl;
    orbit: SurroundOrbit;
    model: SurroundModel;
    plate: boolean;
    /** Свои размеры подложки в метрах; 0 — авто, габарит × 1.5. */
    plateLength: number;
    plateWidth: number;
    /** Разрешение surround-кадра. Смена перезапускает вывод. */
    resolution: { width: number; height: number };
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
    plate_length?: number;
    plate_width?: number;
    resolution?: { width: number; height: number };
    wireframe?: boolean;
    photometric?: boolean;
}

/** Файл из библиотеки моделей. */
export interface SurroundModelFile {
    name: string;
    size: number;
}

/** Версия карт экспорта: поколение печки, created — unix-секунды (0 у легаси). */
export interface TopVersion {
    key: string;
    created: number;
}

/** Рисунок экспорта с действующими правками показа и размера. */
export interface TopImage {
    name: string;
    visible: boolean;
    width: number;
    height: number;
    /** Исходный размер из экспорта — база кнопки сброса. */
    defaultWidth: number;
    defaultHeight: number;
}

/**
 * Настройки плоской сшивки. Всё новое живёт только на версиях текущего
 * поколения печки: generation < currentGeneration — панель предлагает
 * пересчитать.
 */
export interface TopConfig {
    versions: TopVersion[];
    activeVersion: string;
    /** Поколение активной версии. */
    generation: number;
    /** Поколение печки в текущей сборке сервера. */
    currentGeneration: number;
    /** Доступность пересчёта считает сервер: пресет и src-точки видны ему. */
    canRecalc: boolean;
    recalcReason: string;
    /** Ширина шва, доля от меньшей стороны канваса. */
    blend: number;
    photometric: boolean;
    plate: boolean;
    plateLength: number;
    plateWidth: number;
    model: SurroundModel;
    /** Разрешение кадра; по умолчанию — выровненный канвас с поворотом. */
    resolution: { width: number; height: number };
    images: TopImage[];
}

/** Частичное обновление top-блока: только изменившиеся поля. */
export interface TopPatch {
    blend?: number;
    photometric?: boolean;
    plate?: boolean;
    plate_length?: number;
    plate_width?: number;
    model?: Partial<SurroundModel>;
    resolution?: { width: number; height: number };
    /** Правки рисунков по имени файла; тройка шлётся целиком. */
    images?: Record<string, { visible: boolean; width: number; height: number }>;
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
    /** Камера, чей кадр размечали на сборке; префилл назначения без state. */
    cameraId: string | null;
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
    /** Габарит машины из конфигуратора; null у старых записей. */
    machineRect: { x: number; y: number; w: number; h: number } | null;
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
        const list = json.data?.exports ?? json.exports ?? [];
        // Старый сервер флага не шлёт — такие записи считаются годными
        return list.map((e: any): LinkerExport => ({ ...e, valid: e.valid !== false }));
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
            cameraId: typeof cam?.camera_id === 'string' && cam.camera_id ? cam.camera_id : null,
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
            machineRect: toRect(data.machine?.rect),
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
                // Старый сервер базы не шлёт: тогда она равна действующей позе,
                // и кнопки отката просто остаются неактивными
                pnp: {
                    position: [
                        num(c.pnp_position?.[0], num(c.position?.[0], 0)),
                        num(c.pnp_position?.[1], num(c.position?.[1], 0)),
                        num(c.pnp_position?.[2], num(c.position?.[2], 0)),
                    ],
                    yaw: num(c.pnp_yaw, num(c.yaw, 0)),
                    pitch: num(c.pnp_pitch, num(c.pitch, 0)),
                    roll: num(c.pnp_roll, num(c.roll, 0)),
                },
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
                outer: num(bowl.outer, 1.4),
                wall: num(bowl.wall, 0.9),
                plate: num(bowl.plate, 1.5),
                blend: num(bowl.blend, 0.3),
                corner: num(bowl.corner, 1),
            },
            orbit: {
                distance: num(orbit.distance, 3.4),
                height: num(orbit.height, 2.0),
                speed: num(orbit.speed, 0.25),
                interactive: orbit.interactive === true,
            },
            model: {
                length: num(model.length, 0),
                width: num(model.width, 0),
                height: num(model.height, 0),
                alpha: num(model.alpha, 1),
                rotation: num(model.rotation, 0),
                source: typeof model.source === 'string' ? model.source : '',
            },
            plate: d.plate !== false,
            plateLength: num(d.plate_length, 0),
            plateWidth: num(d.plate_width, 0),
            resolution: {
                width: num(d.resolution?.width, 1280),
                height: num(d.resolution?.height, 720),
            },
            wireframe: d.wireframe === true,
            photometric: d.photometric !== false,
            cameras,
        };
    },

    /** Библиотека загруженных моделей .glb. */
    async listModels(): Promise<SurroundModelFile[]> {
        const json = await fetchJson<any>('GET', '/linker/models');
        const list = json.data?.models ?? json.models ?? [];
        return (Array.isArray(list) ? list : [])
            .map((m: any): SurroundModelFile => ({
                name: String(m?.name ?? ''),
                size: Number(m?.size) || 0,
            }))
            .filter(m => m.name);
    },

    /**
     * Файл .glb в библиотеку моделей. Возвращает имя, под которым сохранён;
     * привязка к конфигурации — отдельным postSurround({model:{source}}).
     */
    async uploadModel(file: File): Promise<string> {
        const form = new FormData();
        form.append('model', file, file.name);
        const res = await fetch('/linker/upload-model', { method: 'POST', body: form });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new LinkerError(res.status,
                json.error ?? json.description ?? `${res.status}`);
        }
        return String(json.data?.filename ?? file.name);
    },

    /** Частичный мёрж surround-блока. Живой вывод применяет без рестарта. */
    async postSurround(patch: SurroundPatch, exportId?: string): Promise<void> {
        await fetchJson('POST', '/linker/surround', {
            ...patch,
            ...(exportId ? { export_id: exportId } : {}),
        });
    },

    /** Действующие настройки плоской сшивки с версиями карт. */
    async getTop(exportId?: string): Promise<TopConfig> {
        const path = exportId
            ? `/linker/top?id=${encodeURIComponent(exportId)}`
            : '/linker/top';
        const json = await fetchJson<any>('GET', path);
        const d = json.data ?? json;
        const model = d.model ?? {};

        const versions: TopVersion[] = (Array.isArray(d.versions) ? d.versions : [])
            .map((v: any): TopVersion => ({
                key: String(v?.key ?? ''),
                created: num(v?.created, 0),
            }))
            .filter((v: TopVersion) => v.key);

        return {
            versions: versions.length ? versions : [{ key: 'v1', created: 0 }],
            activeVersion: typeof d.active_version === 'string' ? d.active_version : 'v1',
            generation: num(d.generation, 1),
            currentGeneration: num(d.current_generation, 2),
            canRecalc: d.can_recalc === true,
            recalcReason: typeof d.recalc_reason === 'string' ? d.recalc_reason : '',
            blend: num(d.blend, 0.3),
            photometric: d.photometric !== false,
            plate: d.plate !== false,
            plateLength: num(d.plate_length, 0),
            plateWidth: num(d.plate_width, 0),
            model: {
                length: num(model.length, 0),
                width: num(model.width, 0),
                height: num(model.height, 0),
                alpha: num(model.alpha, 1),
                rotation: num(model.rotation, 0),
                source: typeof model.source === 'string' ? model.source : '',
            },
            resolution: {
                width: num(d.resolution?.width, 0),
                height: num(d.resolution?.height, 0),
            },
            images: (Array.isArray(d.images) ? d.images : [])
                .map((img: any): TopImage => ({
                    name: String(img?.name ?? ''),
                    visible: img?.visible !== false,
                    width: num(img?.width, 0),
                    height: num(img?.height, 0),
                    defaultWidth: num(img?.default_width, 0),
                    defaultHeight: num(img?.default_height, 0),
                }))
                .filter((img: TopImage) => img.name),
        };
    },

    /**
     * Частичный мёрж top-блока. Живой вывод применяет без рестарта;
     * blend перепекает веса на сервере, смена resolution делается
     * фронтовой связкой стоп → запись → старт.
     */
    async postTop(patch: TopPatch, exportId?: string): Promise<void> {
        await fetchJson('POST', '/linker/top', {
            ...patch,
            ...(exportId ? { export_id: exportId } : {}),
        });
    },

    /** Смена активной версии карт; живой top-вывод сервер перезапустит сам. */
    async setTopVersion(version: string, exportId?: string): Promise<void> {
        await fetchJson('POST', '/linker/top-version', {
            version,
            ...(exportId ? { export_id: exportId } : {}),
        });
    },

    /**
     * Полный пересчёт из пресета: src-точки → remap + веса → версия текущего
     * поколения. Синхронный, держится секунды — кнопка показывает спиннер.
     */
    async recalcTop(exportId?: string): Promise<void> {
        await fetchJson('POST', '/linker/recalc',
            exportId ? { export_id: exportId } : {});
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
