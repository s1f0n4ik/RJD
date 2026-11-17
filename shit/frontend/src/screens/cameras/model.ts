import type { CPPCamera, LocalCamera, RtpSettings, StreamPurpose, V4l2Format, V4l2Source } from '../../types';
import { MediaCenterError } from '../../services/api';
import { describeFault, type StreamFault } from '../../components/webrtc/error-codes';

export type Camera = CPPCamera;

/** Поток в форме: ключ неизменяем, остальное правит оператор. */
// Длина сегмента записи по умолчанию — 10 минут; media-center считает в секундах
export const DEFAULT_SEGMENT_SEC = 600;

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
    rtp: RtpSettings;
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
    // Камера в сети или на плате; у камеры на плате адреса и логина нет
    source: 'rtsp' | 'v4l2';
    v4l2: V4l2Source;
    // Устройство-владелец: оно же решает, какие назначения доступны
    device_id: string;
    streams: StreamForm[];
}

// Камера на плате до выбора: формат и режим подставляются из возможностей камеры
export const DEFAULT_V4L2: V4l2Source = {
    device: '', format: 'MJPG', width: 0, height: 0, fps: 0, rotation: 0, swap_uv: false, bitrate: 0, gop: 1,
};

/** Единственный поток камеры на плате. */
export const LOCAL_STREAM = 'stream_1';

export const RESERVED_PREFIXES = ['__probe_'];

// Возраст, после которого пробная камера считается брошенной
const PROBE_STALE_MS = 2 * 60 * 1000;

/** Брошенные пробные камеры. */
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

// Кадр и битрейт 0 — как у исходного потока, сжатие 0 — по умолчанию кодека
export const DEFAULT_RTP: RtpSettings = { host: '', port: 5004, mode: 'copy', width: 0, height: 0, bitrate: 0, qp_max: 0 };

// Наименьший кадр кодека
export const RTP_MIN_WIDTH = 96;
export const RTP_MIN_HEIGHT = 64;
const RTP_HOST_REGEX = /^[A-Za-z0-9._:-]{1,253}$/;

export const MIN_CHANNEL = 1;
export const MAX_CHANNEL = 6;
export const MIN_SUBSTREAM = 1;
export const MAX_SUBSTREAM = 6;

export const PRODUCTION_NAMES: Record<number, string> = { 1: 'Dahua', 2: 'Hikvision', 3: 'ACE' };
export const VENDOR_TO_PRODUCTION: Record<string, number> = { Dahua: 1, Hikvision: 2, ACE: 3 };

export const PURPOSE_ORDER: StreamPurpose[] = ['view', 'record', 'neural', 'birdview', 'rtp'];

export const PURPOSE_NAMES: Record<StreamPurpose, string> = {
    view: 'Просмотр',
    record: 'Запись',
    neural: 'Тех. зрение',
    birdview: '360',
    rtp: 'RTP',
};

/** Назначения, которым нужен модуль на устройстве. */
export const PURPOSE_MODULE: Partial<Record<StreamPurpose, string>> = {
    neural: 'neural',
    birdview: 'birdview',
};

/** Назначения-потребители кадров. */
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
    segment: purposes.includes('record') ? DEFAULT_SEGMENT_SEC : 0,
    rtp: { ...DEFAULT_RTP },
});

/** Включение и выключение назначения потока. */
export const togglePurpose = (stream: StreamForm, purpose: StreamPurpose): Partial<StreamForm> => {
    const has = stream.purposes.includes(purpose);
    const patch: Partial<StreamForm> = {
        purposes: has
            ? stream.purposes.filter(p => p !== purpose)
            : [...stream.purposes, purpose],
    };

    // Запись без пути и сегмента не поднимется
    if (!has && purpose === 'record') {
        if (!stream.record_path) patch.record_path = RECORD_PATH;
        if (stream.segment <= 0) patch.segment = DEFAULT_SEGMENT_SEC;
    }

    return patch;
};

/** Следующий свободный ключ потока. */
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
    source: 'rtsp',
    v4l2: DEFAULT_V4L2,
    device_id: '',
    // Заполняется опросом камеры
    streams: [],
};

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'dim';

/** Класс точки .dot для тона состояния. */
export const dotClass = (tone: StatusTone): string => (tone === 'info' ? 'acc' : tone === 'dim' ? '' : tone);

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
    /** Почему поток не поднялся, по состоянию платы */
    fault: StreamFault | null;
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
            // Данные молчащего устройства из кэша: причина могла устареть
            fault: camera.offline || stream.status === 3 ? null : describeFault(stream.error),
        }))
        .sort((a, b) => a.number - b.number);

/** Первый поток с назначением view. */
export const viewableStream = (camera: Camera): StreamInfo | null =>
    streamsOf(camera).find(stream => stream.purposes.includes('view')) ?? null;

/** tip — полная причина отказа для подсказки. */
export const streamStatus = (stream: StreamInfo, offline: boolean): { label: string; tone: StatusTone; tip?: string } => {
    if (offline) return { label: 'нет данных', tone: 'dim' };
    if (stream.status === 3) return { label: 'идёт', tone: 'ok' };
    if (stream.fault) return { label: stream.fault.label, tone: 'err', tip: stream.fault.text };
    return STATUS_MAP[stream.status] ?? { label: 'неизвестно', tone: 'dim' };
};

/** Состояние камеры из состояний её потоков. */
export const cameraStatus = (camera: Camera): { label: string; detail?: string; tone: StatusTone; tip?: string } => {
    if (camera.offline) return { label: 'устройство молчит', tone: 'err' };
    const streams = streamsOf(camera);
    if (streams.length === 0) return { label: 'потоков нет', tone: 'dim' };

    const dead = streams.filter(s => !s.live);
    if (dead.length === 0) return { label: 'в работе', tone: 'ok' };
    if (dead.length === streams.length) {
        // Все потоки встали по одной причине: она и есть состояние камеры
        const first = dead[0].fault;
        if (first && dead.every(s => s.fault?.code === first.code)) return { label: first.label, tone: 'err', tip: first.text };
        return { label: 'нет потоков', tone: 'err' };
    }
    const detail = dead.some(s => s.fault)
        ? dead.map(s => (s.fault ? `поток ${s.number}: ${s.fault.label}` : `поток ${s.number} молчит`)).join(', ')
        : `поток ${dead.map(s => s.number).join(', ')} молчит`;
    return { label: 'частично', detail, tone: 'warn' };
};

/** Причина, если камера целиком стоит по одной и той же причине платы; иначе пусто. */
export const cameraFaultLabel = (camera: Camera): string => {
    const status = cameraStatus(camera);
    return status.tip ? status.label : '';
};

/** Сводка причин по камерам без потока: «ошибка пароля ×2, камера недоступна». */
export const faultSummary = (cameras: Camera[]): string => {
    const counts = new Map<string, number>();
    for (const camera of cameras) {
        const label = cameraFaultLabel(camera);
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(', ');
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

/** Проверки потоков, те же что на сервере. */
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

        if (stream.purposes.includes('rtp')) {
            const { host, port, mode, width, height, bitrate, qp_max } = stream.rtp;
            if (!RTP_HOST_REGEX.test(host)) {
                return { valid: false, error: `${label}: укажите адрес приёмника RTP — IP или имя хоста` };
            }
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                return { valid: false, error: `${label}: порт RTP в диапазоне 1–65535` };
            }
            if (width < 0 || height < 0 || bitrate < 0) {
                return { valid: false, error: `${label}: размер кадра и битрейт RTP не могут быть отрицательными` };
            }
            if (qp_max < 0 || qp_max > 51) {
                return { valid: false, error: `${label}: степень сжатия RTP в диапазоне 0–51` };
            }
            if (mode === 'transcode' && ((width > 0 && width < RTP_MIN_WIDTH) || (height > 0 && height < RTP_MIN_HEIGHT))) {
                return { valid: false, error: `${label}: кадр RTP не меньше ${RTP_MIN_WIDTH}×${RTP_MIN_HEIGHT}` };
            }
        }
    }

    return { valid: true };
};

export const V4L2_ROTATIONS = [0, 90, 180, 270];

export const isLocalCamera = (camera?: { source?: string } | null): boolean => camera?.source === 'v4l2';

// CSI задаётся именем узла ISP, USB — путём /dev/v4l/by-path/...
export const isCsiDevice = (device: string): boolean => !!device && !device.startsWith('/dev/');

/** YUYV и UYVY кодер не поворачивает: остаётся только 180 сенсором CSI. */
export const rotationAllowed = (v4l2: V4l2Source, angle: number): boolean =>
    angle === 0 || (v4l2.format !== 'YUYV' && v4l2.format !== 'UYVY') || (isCsiDevice(v4l2.device) && angle === 180);

/** Проверки камеры на плате, те же что на сервере. */
export const validateV4l2 = (v4l2: V4l2Source): Validation => {
    if (!v4l2.device) return { valid: false, error: 'Выберите камеру платы' };
    if (!['YUYV', 'UYVY', 'NV12', 'MJPG'].includes(v4l2.format)) return { valid: false, error: 'Формат: YUYV, UYVY, NV12 или MJPG' };
    if (v4l2.width <= 0 || v4l2.height <= 0 || v4l2.width % 2 || v4l2.height % 2) {
        return { valid: false, error: 'Стороны кадра больше нуля и чётные' };
    }
    if (v4l2.fps < 1 || v4l2.fps > 120) return { valid: false, error: 'Кадров/с в диапазоне 1–120' };
    if (!V4L2_ROTATIONS.includes(v4l2.rotation)) return { valid: false, error: 'Поворот 0°, 90°, 180° или 270°' };
    if (!rotationAllowed(v4l2, v4l2.rotation)) return { valid: false, error: `${v4l2.format} не поворачивается: выберите MJPG или NV12` };
    if (v4l2.bitrate < 0) return { valid: false, error: 'Битрейт не может быть отрицательным' };
    if (v4l2.gop < 1 || v4l2.gop > 60) return { valid: false, error: 'Опорный кадр раз в 1–60 с' };
    return { valid: true };
};

// Значение внутри диапазона драйвера с его шагом
const fitsRange = (value: number, low: number, high: number, step: number) =>
    value >= low && value <= high && (step <= 1 || (value - low) % step === 0);

/** Почему камера не снимет такой режим; пусто — снимет. */
export const modeError = (camera: LocalCamera, v4l2: V4l2Source): string => {
    const frame = `${v4l2.width}×${v4l2.height}`;
    const format = camera.formats.find(f => f.format === v4l2.format);
    if (!format) return `Камера не отдаёт ${v4l2.format}`;
    if (format.range) {
        const r = format.range;
        const ok = fitsRange(v4l2.width, r.min_width, r.max_width, r.step_width)
            && fitsRange(v4l2.height, r.min_height, r.max_height, r.step_height);
        return ok ? '' : `Камера не снимает ${frame} в ${v4l2.format}`;
    }
    const size = format.sizes?.find(s => s.width === v4l2.width && s.height === v4l2.height);
    if (!size) return `Камера не снимает ${frame} в ${v4l2.format}`;
    if (size.fps.length > 0 && !size.fps.includes(v4l2.fps)) return `Камера не снимает ${frame} ${v4l2.format} с частотой ${v4l2.fps} к/с`;
    return '';
};

// Ближайшее к желаемому значение диапазона: не больше верхней границы, на сетке шага
const clampRange = (want: number, low: number, high: number, step: number) => {
    const value = Math.min(Math.max(want, low), high);
    return step > 1 ? low + Math.floor((value - low) / step) * step : value;
};

/** Режим камеры в формате: прежний размер и частота, если камера их умеет, иначе первые из её списка. */
export const modeFor = (camera: LocalCamera, format: string, current: V4l2Source): V4l2Source => {
    const found = camera.formats.find(f => f.format === format) ?? camera.formats[0];
    const next: V4l2Source = { ...current, device: camera.device, format: found.format as V4l2Format };
    if (found.range) {
        const r = found.range;
        next.width = clampRange(current.width || 1920, r.min_width, r.max_width, r.step_width);
        next.height = clampRange(current.height || 1080, r.min_height, r.max_height, r.step_height);
        next.fps = current.fps || 20;
    }
    else {
        const sizes = found.sizes ?? [];
        const size = sizes.find(s => s.width === current.width && s.height === current.height) ?? sizes[0];
        next.width = size?.width ?? 0;
        next.height = size?.height ?? 0;
        const rates = size?.fps ?? [];
        next.fps = rates.length > 0 ? (rates.includes(current.fps) ? current.fps : rates[0]) : current.fps || 25;
    }
    if (next.format === 'MJPG') next.swap_uv = false;
    if (!rotationAllowed(next, next.rotation)) next.rotation = 0;
    return next;
};

// Порт USB из адреса by-path: ...-usb-0:1.2:1.0-video-index0 даёт 1.2
const usbPort = (device: string): string => device.match(/usb-\d+:([\d.]+):/)?.[1] ?? '';

/** Адрес для списка: IP у камеры в сети, «USB 1.2» или «CSI» у камеры на плате. */
export const cameraAddress = (camera: { ip_adress?: string; source?: string; v4l2?: { device?: string } }): string => {
    if (!isLocalCamera(camera)) return camera.ip_adress ?? '';
    const device = camera.v4l2?.device ?? '';
    if (isCsiDevice(device)) return 'CSI';
    const port = usbPort(device);
    return port ? `USB ${port}` : 'USB';
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
    source: camera.source === 'v4l2' ? 'v4l2' : 'rtsp',
    v4l2: { ...DEFAULT_V4L2, ...camera.v4l2 },
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
            rtp: { ...DEFAULT_RTP, ...raw.rtp },
        };
    }),
});

/** Как уходит трансляция: без перекодирования или с каким кадром, битрейтом и сжатием. */
export const rtpSummary = (rtp: RtpSettings): string => {
    if (rtp.mode === 'copy') return 'без перекодирования';
    const frame = rtp.width > 0 || rtp.height > 0 ? `${rtp.width || '…'}×${rtp.height || '…'}` : 'исходный кадр';
    return [
        'перекодирование',
        frame,
        rtp.bitrate > 0 ? `${rtp.bitrate} кбит/с` : '',
        rtp.qp_max > 0 ? `QP до ${rtp.qp_max}` : '',
    ].filter(Boolean).join(' · ');
};

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
    // Цель трансляции имеет смысл только при назначении rtp
    ...(stream.purposes.includes('rtp') ? { rtp: stream.rtp } : {}),
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
    ...(form.source === 'v4l2' ? { source: 'v4l2', v4l2: form.v4l2 } : {}),
    streams: Object.fromEntries(form.streams.map(stream => [stream.key, streamToPayload(stream)])),
});

/** Единое место форматирования ошибок для UI. */
export const formatError = (err: unknown): string => {
    if (err instanceof MediaCenterError && err.code === 409 && err.message.startsWith('Camera id is taken')) {
        return `Камера с таким id уже есть на устройстве «${err.details}»`;
    }
    if (err instanceof MediaCenterError && err.code === 409 && err.message.startsWith('Camera is already added')) {
        return `Камера уже добавлена: ${err.details}`;
    }
    if (err instanceof MediaCenterError) return err.message;
    if (err instanceof Error) return err.message;
    return String(err);
};
