import { storagePath } from '../../services/devices';

/*
    Данные экрана архива.

    Время везде — миллисекунды настенного времени изделия: шлюз отдаёт unix_ms
    уже сдвинутым на настроенный пояс, поэтому форматируется всё UTC-геттерами.
    Иначе браузер добавит свой пояс вторым слоем.
*/

export interface Segment {
    id: number;
    camera_id: string;
    stream_key: string;
    path: string;
    file: string;
    start_ms: number;
    end_ms: number;
    size_bytes: number;
    closed: boolean;
    origin: string;
    trusted: boolean;
    session_uid: string;
    estimated_end?: boolean;
}

export interface Run {
    start_ms: number;
    end_ms: number;
}

/** record — запись прервалась, power — изделие было обесточено. */
export interface Gap {
    start_ms: number;
    end_ms: number;
    kind: 'record' | 'power';
}

export interface Track {
    camera_id: string;
    stream_key: string;
    device_id: string;
    device_name: string;
    trusted: boolean;
    recorded_ms: number;
    bytes: number;
    segment_count: number;
    runs: Run[];
    gaps: Gap[];
    segments: Segment[];
}

export interface DayIndex {
    date: string;
    tracks: Track[];
    offline_devices: string[];
}

export interface DaySummary {
    date: string;
    recorded_ms: number;
    bytes: number;
    segment_count: number;
    track_count: number;
    trusted: boolean;
}

export interface ArchiveState {
    first_ms: number | null;
    last_ms: number | null;
    bytes: number;
    segment_count: number;
    untrusted_sessions: number;
    devices: Array<{
        device_id: string;
        device_name: string;
        available?: boolean;
        disk?: {
            total_bytes: number;
            used_bytes: number;
            free_bytes: number;
            used_percent: number;
        };
    }>;
    offline_devices: string[];
}

export const DAY_MS = 86_400_000;

// ── запросы ──

async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} → ${response.status}`);
    return response.json() as Promise<T>;
}

export const fetchDay = (date: string) =>
    getJson<DayIndex>(`/api/archive/day?date=${date}`);

export const fetchDays = (from: string, to: string) =>
    getJson<{ days: DaySummary[] }>(`/api/archive/days?from=${from}&to=${to}`);

export const fetchState = () =>
    getJson<ArchiveState>('/api/archive/state');

/** Адрес файла сегмента на устройстве, которое его писало. */
export function segmentUrl(track: Track, segment: Segment, download = false): string {
    const kind = download ? 'download' : 'stream';
    const query = `?stream=${encodeURIComponent(track.stream_key)}`;
    return storagePath(
        track.device_id,
        `/api/recordings/${kind}/${encodeURIComponent(track.camera_id)}/${encodeURIComponent(segment.file)}${query}`,
    );
}

// ── ключи и подписи ──

export const trackKey = (track: Track) =>
    `${track.device_id}/${track.camera_id}/${track.stream_key}`;

/**
 * Подпись дорожки: имя камеры, а когда у камеры пишется несколько потоков —
 * с номером канала. Дорожка — это поток, а не камера.
 */
export function trackTitle(track: Track, tracks: Track[], cameraNames: Map<string, string>): string {
    const name = cameraNames.get(track.camera_id) || track.camera_id;
    const siblings = tracks.filter(
        other => other.camera_id === track.camera_id && other.device_id === track.device_id,
    );
    if (siblings.length < 2) return name;
    return `${name} · ${track.stream_key.replace('stream_', 'канал ')}`;
}

// ── время ──

const TIME_FMT: Intl.DateTimeFormatOptions = {
    timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit',
};

const DATE_FMT: Intl.DateTimeFormatOptions = {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
};

export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', TIME_FMT);
export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', DATE_FMT);

/** Ключ суток YYYY-MM-DD из миллисекунд времени изделия. */
export function dateKey(ms: number): string {
    const date = new Date(ms);
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function dayStartMs(key: string): number {
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
}

export function shiftDay(key: string, days: number): string {
    return dateKey(dayStartMs(key) + days * DAY_MS);
}

export function fmtDuration(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
    const seconds = total % 60;
    if (minutes > 0) return `${minutes} мин ${String(seconds).padStart(2, '0')} с`;
    return `${seconds} с`;
}

export function fmtBytes(bytes: number): string {
    if (!bytes) return '0 ГБ';
    const gb = bytes / 1024 ** 3;
    if (gb >= 1) return `${gb.toFixed(1).replace('.', ',')} ГБ`;
    return `${(bytes / 1024 ** 2).toFixed(0)} МБ`;
}

export const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function weekdayShort(key: string): string {
    return WEEKDAYS[new Date(dayStartMs(key)).getUTCDay()];
}

// ── геометрия дорожки ──

/** Доля суток в процентах — позиция на полосе. */
export const percentOf = (ms: number, dayStart: number) =>
    Math.min(100, Math.max(0, ((ms - dayStart) / DAY_MS) * 100));

export const msAtPercent = (percent: number, dayStart: number) =>
    dayStart + (percent / 100) * DAY_MS;

/** Сегмент, внутри которого лежит момент. */
export function segmentAt(track: Track, ms: number): Segment | null {
    return track.segments.find(s => s.start_ms <= ms && ms < s.end_ms) || null;
}

/** Ближайший сегмент, начинающийся не раньше момента, — куда прыгать через разрыв. */
export function segmentAfter(track: Track, ms: number): Segment | null {
    return track.segments.find(s => s.start_ms >= ms) || null;
}

/** Записан ли момент: попадает ли он в непрерывный кусок. */
export const isRecorded = (track: Track, ms: number) =>
    track.runs.some(run => run.start_ms <= ms && ms < run.end_ms);

/** Сколько записи внутри диапазона — то, что реально попадёт в склейку. */
export function recordedWithin(track: Track, from: number, to: number): number {
    return track.runs.reduce((sum, run) => {
        const start = Math.max(run.start_ms, from);
        const end = Math.min(run.end_ms, to);
        return sum + Math.max(0, end - start);
    }, 0);
}

/** Разрывы, попавшие в диапазон: о них предупреждаем до склейки. */
export function gapsWithin(track: Track, from: number, to: number): Gap[] {
    return track.gaps.filter(gap => gap.end_ms > from && gap.start_ms < to);
}

/** Оценка размера куска по средней плотности записи на дорожке. */
export function estimateBytes(track: Track, ms: number): number {
    if (!track.recorded_ms) return 0;
    return Math.round((track.bytes / track.recorded_ms) * ms);
}

// ── задачи склейки и выгрузки ──

export interface JobProgress {
    status: string;
    progress: number;
    message: string;
    error?: string | null;
    result_filename?: string;
}

async function postJson(url: string, body: unknown): Promise<{ job_id: string }> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `${response.status}`);
    }
    return response.json();
}

/** Склейка диапазона в один файл; возвращает идентификатор задачи. */
export function startCut(track: Track, fromMs: number, toMs: number) {
    return postJson(storagePath(track.device_id, '/api/archive/cut'), {
        camera: track.camera_id,
        stream: track.stream_key,
        from_ms: Math.round(fromMs),
        to_ms: Math.round(toMs),
    });
}

/** Выгрузка исходных сегментов диапазона архивом. */
export function startZip(track: Track, fromMs: number, toMs: number) {
    return postJson(storagePath(track.device_id, '/api/archive/zip'), {
        camera: track.camera_id,
        stream: track.stream_key,
        from_ms: Math.round(fromMs),
        to_ms: Math.round(toMs),
    });
}

export function jobProgressUrl(deviceId: string, jobId: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = storagePath(deviceId, `/api/recordings/jobs/${jobId}/progress`);
    return `${proto}//${window.location.host}${path}`;
}

export const jobDownloadUrl = (deviceId: string, jobId: string) =>
    storagePath(deviceId, `/api/recordings/jobs/${jobId}/download`);

export const jobCancelUrl = (deviceId: string, jobId: string) =>
    storagePath(deviceId, `/api/recordings/jobs/${jobId}`);
