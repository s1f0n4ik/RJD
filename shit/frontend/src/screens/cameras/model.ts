import type { CPPCamera, StreamPurpose } from '../../types';
import { MediaCenterError } from '../../services/api';

export type Camera = CPPCamera;

/** Поток в форме: ключ неизменяем, остальное правит оператор. */
export interface StreamForm {
    key: string;
    channel: number;
    substream: number;
    purposes: StreamPurpose[];
    latency: number;
    use_udp: boolean;
    reconnect: number;
    record_path: string;
    segment: number;
}

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
    // Устройство-владелец: оно же решает, какие назначения доступны
    device_id: string;
    streams: StreamForm[];
}

export const RESERVED_PREFIXES = ['__probe_'];

/*
    Возраст, после которого пробная камера считается брошенной. Координировать
    уборку с активным превью нельзя — оно живёт в мастере, а список в экране,
    — поэтому ориентир по времени: в имени лежит метка `__probe_<Date.now()>`.
*/
const PROBE_STALE_MS = 2 * 60 * 1000;

/** Брошенные пробные камеры: держат сессию к камере и не видны в списке. */
export const staleProbes = (cameras: Camera[]): Camera[] => {
    const now = Date.now();

    return cameras.filter(camera => {
        const match = camera.id.match(/^__probe_(\d+)$/);
        if (!match) return false;
        return now - Number(match[1]) > PROBE_STALE_MS;
    });
};
const NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]{1,31}$/;
const IP_REGEX = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const STREAM_KEY_REGEX = /^stream_([1-9][0-9]*)$/;

export const RECORD_PATH = '/storage/internal';

export const MIN_CHANNEL = 1;
export const MAX_CHANNEL = 6;
export const MIN_SUBSTREAM = 1;
export const MAX_SUBSTREAM = 6;

export const PRODUCTION_NAMES: Record<number, string> = { 1: 'Dahua', 2: 'Hikvision', 3: 'ACE' };
export const VENDOR_TO_PRODUCTION: Record<string, number> = { Dahua: 1, Hikvision: 2, ACE: 3 };

export const PURPOSE_ORDER: StreamPurpose[] = ['view', 'record', 'neural', 'birdview'];

export const PURPOSE_NAMES: Record<StreamPurpose, string> = {
    view: 'Просмотр',
    record: 'Запись',
    neural: 'Тех. зрение',
    birdview: '360',
};

/** Назначения, которым нужен модуль на устройстве; остальные есть всегда. */
export const PURPOSE_MODULE: Partial<Record<StreamPurpose, string>> = {
    neural: 'neural',
    birdview: 'birdview',
};

/** Кадры отдаются одним приёмником, поэтому потребитель у потока один. */
export const CONSUMER_PURPOSES: StreamPurpose[] = ['neural', 'birdview'];

export const purposeAvailable = (purpose: StreamPurpose, modules: string[]): boolean => {
    const required = PURPOSE_MODULE[purpose];
    return !required || modules.includes(required);
};

export const makeStream = (key: string, substream: number, purposes: StreamPurpose[]): StreamForm => ({
    key,
    channel: MIN_CHANNEL,
    substream,
    purposes,
    latency: 0,
    use_udp: false,
    reconnect: 10,
    record_path: purposes.includes('record') ? RECORD_PATH : '',
    segment: purposes.includes('record') ? 10 : 0,
});

/**
 * Включение и выключение назначения. Вынесено в модель, потому что
 * применяется из двух мест — карточки потока в мастере и полей в шторке.
 */
export const togglePurpose = (stream: StreamForm, purpose: StreamPurpose): Partial<StreamForm> => {
    const has = stream.purposes.includes(purpose);
    const patch: Partial<StreamForm> = {
        purposes: has
            ? stream.purposes.filter(p => p !== purpose)
            : [...stream.purposes, purpose],
    };

    // Запись без пути и сегмента не поднимется — подставляем рабочие значения
    if (!has && purpose === 'record') {
        if (!stream.record_path) patch.record_path = RECORD_PATH;
        if (stream.segment <= 0) patch.segment = 10;
    }

    return patch;
};

/** Следующий свободный ключ: номера не переиспользуются в рамках сессии правки. */
export const nextStreamKey = (streams: StreamForm[]): string => {
    const used = new Set<number>();
    for (const stream of streams) {
        const match = stream.key.match(STREAM_KEY_REGEX);
        if (match) used.add(parseInt(match[1], 10));
    }
    let n = 1;
    while (used.has(n)) n++;
    return `stream_${n}`;
};

export const streamNumber = (key: string): number => {
    const match = key.match(STREAM_KEY_REGEX);
    return match ? parseInt(match[1], 10) : 0;
};

export const DEFAULT_FORM: CameraFormData = {
    id: '',
    display_name: '',
    description: '',
    ip_adress: '',
    port: '554',
    user: 'admin',
    password: '',
    production: 2,
    device_id: '',
    // Пусто намеренно: какие субпотоки есть у камеры, выясняет опрос
    streams: [],
};

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'dim';

export interface StreamInfo {
    key: string;
    number: number;
    channel: number;
    substream: number;
    purposes: StreamPurpose[];
    width: number;
    height: number;
    fps: number;
    codec: string;
    latency: number;
    useUdp: boolean;
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
    Object.entries(camera.streams ?? {})
        .map(([key, stream]) => ({
            key,
            number: streamNumber(key),
            channel: stream.channel,
            substream: stream.substream,
            purposes: stream.purposes ?? [],
            width: stream.width,
            height: stream.height,
            fps: stream.fps,
            codec: stream.codec,
            latency: stream.latency,
            useUdp: stream.use_udp,
            status: stream.status,
            rtsp: hideCredentials(stream.rtsp),
            live: !camera.offline && stream.status === 3,
        }))
        .sort((a, b) => a.number - b.number);

/** Первый поток, который можно смотреть: его и открывает превью по умолчанию. */
export const viewableStream = (camera: Camera): StreamInfo | null =>
    streamsOf(camera).find(stream => stream.purposes.includes('view')) ?? null;

export const streamStatus = (stream: StreamInfo, offline: boolean): { label: string; tone: StatusTone } => {
    if (offline) return { label: 'нет данных', tone: 'dim' };
    if (stream.status === 3) return { label: 'идёт', tone: 'ok' };
    return STATUS_MAP[stream.status] ?? { label: 'неизвестно', tone: 'dim' };
};

/** Состояние камеры складывается из её потоков — молчащий виден в строке. */
export const cameraStatus = (camera: Camera): { label: string; tone: StatusTone } => {
    if (camera.offline) return { label: 'устройство молчит', tone: 'err' };
    const streams = streamsOf(camera);
    if (streams.length === 0) return { label: 'потоков нет', tone: 'dim' };

    const dead = streams.filter(s => !s.live);
    if (dead.length === 0) return { label: 'в работе', tone: 'ok' };
    if (dead.length === streams.length) return { label: 'нет потоков', tone: 'err' };
    return { label: `частично · поток ${dead.map(s => s.number).join(', ')} молчит`, tone: 'warn' };
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

/**
 * Проверки потоков повторяют серверные. Дублирование намеренное: без него
 * отказ приходит уже после отправки, когда часть камеры создана.
 */
export const validateStreams = (streams: StreamForm[], modules: string[]): Validation => {
    if (streams.length === 0) {
        return { valid: false, error: 'Добавьте хотя бы один поток' };
    }

    const owners: Partial<Record<StreamPurpose, string>> = {};

    for (const stream of streams) {
        const label = `Поток ${streamNumber(stream.key)}`;

        if (stream.purposes.length === 0) {
            return { valid: false, error: `${label}: выберите хотя бы одно назначение` };
        }

        if (stream.substream < MIN_SUBSTREAM || stream.substream > MAX_SUBSTREAM) {
            return { valid: false, error: `${label}: субпоток вне диапазона ${MIN_SUBSTREAM}…${MAX_SUBSTREAM}` };
        }

        for (const purpose of stream.purposes) {
            if (!purposeAvailable(purpose, modules)) {
                return {
                    valid: false,
                    error: `${label}: «${PURPOSE_NAMES[purpose]}» недоступно — на устройстве нет модуля ${PURPOSE_MODULE[purpose]}`,
                };
            }
        }

        const consumers = stream.purposes.filter(p => CONSUMER_PURPOSES.includes(p));
        if (consumers.length > 1) {
            return {
                valid: false,
                error: `${label}: кадры отдаются одному потребителю — оставьте либо «Тех. зрение», либо «360»`,
            };
        }

        for (const purpose of consumers) {
            const owner = owners[purpose];
            if (owner) {
                return {
                    valid: false,
                    error: `«${PURPOSE_NAMES[purpose]}» уже назначено потоку ${streamNumber(owner)} — на камеру можно только одно`,
                };
            }
            owners[purpose] = stream.key;
        }

        if (stream.purposes.includes('record')) {
            if (!stream.record_path) {
                return { valid: false, error: `${label}: не задан путь записи` };
            }
            if (stream.segment <= 0) {
                return { valid: false, error: `${label}: длина сегмента должна быть больше нуля` };
            }
        }
    }

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

export const deviceOf = (camera?: Camera | null): string => camera?.device_id ?? '';

export const formFromCamera = (camera: Camera): CameraFormData => ({
    id: camera.id,
    display_name: camera.display_name || camera.id,
    description: camera.description,
    ip_adress: camera.ip_adress,
    port: camera.port,
    user: camera.user,
    password: camera.password || '',
    production: camera.production,
    device_id: camera.device_id ?? '',
    streams: streamsOf(camera).map(stream => {
        const raw = camera.streams[stream.key];
        return {
            key: stream.key,
            channel: raw.channel,
            substream: raw.substream,
            purposes: [...(raw.purposes ?? [])],
            latency: raw.latency,
            use_udp: raw.use_udp,
            reconnect: raw.reconnect,
            record_path: raw.record_path,
            segment: raw.segment,
        };
    }),
});

/** Один поток в виде, который принимает media-center. */
export const streamToPayload = (stream: StreamForm) => ({
    channel: stream.channel,
    substream: stream.substream,
    purposes: [...stream.purposes],
    latency: stream.latency,
    use_udp: stream.use_udp,
    reconnect: stream.reconnect,
    // Путь и сегмент имеют смысл только при записи
    record_path: stream.purposes.includes('record') ? stream.record_path : '',
    segment: stream.purposes.includes('record') ? stream.segment : 0,
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
    streams: Object.fromEntries(form.streams.map(stream => [stream.key, streamToPayload(stream)])),
});

/** Единое место форматирования ошибок для UI. */
export const formatError = (err: unknown): string => {
    if (err instanceof MediaCenterError) return err.message;
    if (err instanceof Error) return err.message;
    return String(err);
};
