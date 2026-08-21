import type { CPPCamera } from '../../types';
import { deviceForCameraType } from '../../services/devices';
import { MediaCenterError } from '../../services/api';

export type Camera = CPPCamera;

/** Плоская форма камеры: то, что редактируют панель и мастер добавления. */
export interface CameraFormData {
    id: string;
    display_name: string;
    description: string;
    ip_adress: string;
    port: string;
    user: string;
    password: string;
    production: number;
    type: number;
    main_sub: number;
    main_latency: number;
    main_use_udp: boolean;
    main_reconnect: number;
    main_segment: number;
    sub_sub: number;
    sub_latency: number;
    sub_use_udp: boolean;
    sub_reconnect: number;
    to_record: boolean;
}

export const RESERVED_PREFIXES = ['__probe_'];
const NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]{1,31}$/;
const IP_REGEX = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export const RECORD_PATH = '/storage/internal';

export const DEFAULT_FORM: CameraFormData = {
    id: '',
    display_name: '',
    description: 'Test Camera',
    ip_adress: '',
    port: '554',
    user: 'admin',
    password: 'VniiTest',
    production: 2,
    type: 1,
    main_sub: 1,
    main_latency: 0,
    main_use_udp: false,
    main_reconnect: 10,
    main_segment: 10,
    sub_sub: 2,
    sub_latency: 0,
    sub_use_udp: false,
    sub_reconnect: 10,
    to_record: true,
};

export const PRODUCTION_NAMES: Record<number, string> = { 1: 'Dahua', 2: 'Hikvision', 3: 'ACE' };
export const VENDOR_TO_PRODUCTION: Record<string, number> = { Dahua: 1, Hikvision: 2, ACE: 3 };
export const TYPE_NAMES: Record<number, string> = { 1: 'Обычная', 2: 'Тех. зрение', 3: 'Камера 360' };

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'dim';

/** Слоты потоков камеры: имена внутренние, оператору видны номера каналов. */
export type StreamKey = 'main' | 'sub';

export interface StreamInfo {
    key: StreamKey;
    channel: number;
    width: number;
    height: number;
    fps: number;
    codec: string;
    latency: number;
    useUdp: boolean;
    toRecord: boolean;
    status: number;
    rtsp: string;
    live: boolean;
}

// Статус 1 (READY) — пайплайн не запущен, для пользователя это «не в сети»
export const STATUS_MAP: Record<number, { label: string; tone: StatusTone }> = {
    0: { label: 'отсутствует', tone: 'err' },
    1: { label: 'не в сети', tone: 'err' },
    2: { label: 'остановлена', tone: 'warn' },
    3: { label: 'в работе', tone: 'ok' },
    4: { label: 'перезапуск', tone: 'warn' },
    5: { label: 'инициализация', tone: 'info' },
};

/** Пароль живёт прямо в rtsp-адресе — наружу его не показываем. */
export const hideCredentials = (rtsp: string): string =>
    rtsp ? rtsp.replace(/^(rtsp:\/\/)[^@/]*@/i, '$1') : '';

export const streamsOf = (camera: Camera): StreamInfo[] =>
    (['main', 'sub'] as StreamKey[])
        .map(key => {
            const s = camera.streams?.[key];
            if (!s) return null;
            return {
                key,
                channel: s.sub,
                width: s.width,
                height: s.height,
                fps: s.fps,
                codec: s.codec,
                latency: s.latency,
                useUdp: s.use_udp,
                toRecord: s.to_record,
                status: s.status,
                rtsp: hideCredentials(s.rtsp),
                live: !camera.offline && s.status === 3,
            };
        })
        .filter((s): s is StreamInfo => s !== null);

export const streamStatus = (stream: StreamInfo, offline: boolean): { label: string; tone: StatusTone } => {
    if (offline) return { label: 'нет данных', tone: 'dim' };
    if (stream.status === 3) return { label: 'идёт', tone: 'ok' };
    return STATUS_MAP[stream.status] ?? { label: 'неизвестно', tone: 'dim' };
};

/** Состояние камеры складывается из её потоков — молчащий канал виден в строке. */
export const cameraStatus = (camera: Camera): { label: string; tone: StatusTone } => {
    if (camera.offline) return { label: 'устройство молчит', tone: 'err' };
    const streams = streamsOf(camera);
    if (streams.length === 0) return { label: 'потоков нет', tone: 'dim' };

    const dead = streams.filter(s => !s.live);
    if (dead.length === 0) return { label: 'в работе', tone: 'ok' };
    if (dead.length === streams.length) return { label: 'нет потоков', tone: 'err' };
    return { label: `частично · канал ${dead.map(s => s.channel).join(', ')} молчит`, tone: 'warn' };
};

export interface Validation {
    valid: boolean;
    error?: string;
}

export const validateCameraName = (name: string, existing: string[], editMode: boolean): Validation => {
    if (!name) return { valid: true }; // пустое имя — сгенерируем camera_N
    if (RESERVED_PREFIXES.some(p => name.startsWith(p))) {
        return { valid: false, error: 'Этот префикс зарезервирован системой' };
    }
    if (!NAME_REGEX.test(name)) {
        return { valid: false, error: 'Только латиница, цифры, _ и -. Длина 2–32, не начинается с цифры' };
    }
    if (!editMode && existing.includes(name)) {
        return { valid: false, error: 'Камера с таким именем уже существует' };
    }
    return { valid: true };
};

export const validateIp = (ip: string): Validation => {
    if (!ip) return { valid: false, error: 'IP-адрес обязателен' };
    if (!IP_REGEX.test(ip)) return { valid: false, error: 'Некорректный IP-адрес' };
    return { valid: true };
};

export const validatePort = (port: string): Validation => {
    if (!port) return { valid: false, error: 'Порт обязателен' };
    const n = parseInt(port, 10);
    if (isNaN(n) || n < 1 || n > 65535) return { valid: false, error: 'Порт в диапазоне 1–65535' };
    return { valid: true };
};

export const findNextFreeCameraId = (cameras: Camera[]): string => {
    const used = new Set<number>();
    for (const c of cameras) {
        const m = c.id.match(/^camera_(\d+)$/);
        if (m) used.add(parseInt(m[1], 10));
    }
    let n = 1;
    while (used.has(n)) n++;
    return `camera_${n}`;
};

export const ipToNumber = (ip: string): number => {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return -1; // некорректный IP — в начало
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
};

// Устройство-владелец камеры; для новых — по таблице «тип → устройство»
export const deviceOf = (camera?: Camera | null): string =>
    camera?.device_id ?? deviceForCameraType(Number(camera?.type ?? 1));

export const formFromCamera = (camera: Camera): CameraFormData => ({
    id: camera.id,
    display_name: camera.display_name || camera.id,
    description: camera.description,
    ip_adress: camera.ip_adress,
    port: camera.port,
    user: camera.user,
    password: camera.password || '',
    production: camera.production,
    type: camera.type,
    main_sub: camera.streams.main.sub,
    main_latency: camera.streams.main.latency,
    main_use_udp: camera.streams.main.use_udp,
    main_reconnect: camera.streams.main.reconnect,
    main_segment: camera.streams.main.segment,
    sub_sub: camera.streams.sub.sub,
    sub_latency: camera.streams.sub.latency,
    sub_use_udp: camera.streams.sub.use_udp,
    sub_reconnect: camera.streams.sub.reconnect,
    to_record: camera.streams.main.to_record ?? false,
});

/** Полный payload создания камеры — общий для мастера и миграции. */
export const formToPayload = (form: CameraFormData, id: string): any => ({
    id,
    display_name: form.display_name || id,
    description: form.description,
    ip_adress: form.ip_adress,
    port: form.port,
    user: form.user,
    password: form.password,
    production: form.production,
    type: form.type,
    streams: {
        main: {
            type: 1,
            sub: form.main_sub,
            latency: form.main_latency,
            use_udp: form.main_use_udp,
            reconnect: form.main_reconnect,
            record_path: RECORD_PATH,
            segment: form.main_segment,
            to_record: form.to_record,
        },
        sub: {
            type: 2,
            sub: form.sub_sub,
            latency: form.sub_latency,
            use_udp: form.sub_use_udp,
            reconnect: form.sub_reconnect,
            record_path: '',
            segment: 0,
            to_record: false,
        },
    },
});

/** Единое место форматирования ошибок для UI. */
export const formatError = (err: unknown): string => {
    if (err instanceof MediaCenterError) return err.message;
    if (err instanceof Error) return err.message;
    return String(err);
};
