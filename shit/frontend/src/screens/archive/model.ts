import { storagePath } from '../../services/devices';

// Данные экрана архива

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
    // false — файл на извлечённом диске пула; disk — его имя
    available?: boolean;
    disk?: string | null;
}

// available:false — кусок лежит на неподключённом диске, disk — имя диска
export interface Run {
    start_ms: number;
    end_ms: number;
    available?: boolean;
    disk?: string | null;
}

// record — запись прервалась, power — изделие было обесточено
export interface Gap {
    start_ms: number;
    end_ms: number;
    kind: 'record' | 'power';
}

// Дорожка таймлайна
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
}

// Дорожка вместе с подгруженными сегментами — то, что играет плеер
export interface LoadedTrack extends Track {
    segments: Segment[];
}

export interface DayIndex {
    date: string;
    tracks: LoadedTrack[];
    offline_devices: string[];
}

// Форма архива целиком: границы глубины и дорожки без сегментов
export interface ArchiveShape {
    first_ms: number | null;
    last_ms: number | null;
    tracks: Track[];
    offline_devices: string[];
}

// Дорожка в сутках календаря: куски записи, обрезанные по границам суток
export interface DayTrack {
    camera_id: string;
    stream_key: string;
    device_id: string;
    recorded_ms: number;
    runs: Run[];
}

export interface DaySummary {
    date: string;
    recorded_ms: number;
    bytes: number;
    segment_count: number;
    track_count: number;
    trusted: boolean;
    tracks: DayTrack[];
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

// Дорожки за произвольное окно времени — вместе с сегментами
export const fetchRange = (fromMs: number, toMs: number) =>
    getJson<DayIndex>(`/api/archive/range?from_ms=${Math.round(fromMs)}&to_ms=${Math.round(toMs)}`);

// Форма всего архива: куски и разрывы без сегментов — это рисует таймлайн
export const fetchShape = () =>
    getJson<ArchiveShape>('/api/archive/shape');

// Сегменты одной дорожки в отрезке — по ним плеер открывает файлы
export function fetchSegments(track: Track, fromMs: number, toMs: number) {
    const query = `camera=${encodeURIComponent(track.camera_id)}`
        + `&stream=${encodeURIComponent(track.stream_key)}`
        + `&device=${encodeURIComponent(track.device_id)}`
        + `&from_ms=${Math.round(fromMs)}&to_ms=${Math.round(toMs)}`;
    return getJson<{ segments: Segment[] }>(`/api/archive/segments?${query}`);
}

export const fetchDays = (from: string, to: string) =>
    getJson<{ days: DaySummary[]; offline_devices: string[] }>(`/api/archive/days?from=${from}&to=${to}`);

export const fetchState = () =>
    getJson<ArchiveState>('/api/archive/state');

// Адрес файла сегмента на устройстве, которое его писало: по строке индекса, на любом томе пула
export function segmentUrl(track: Track, segment: Segment, download = false): string {
    return storagePath(track.device_id, `/api/archive/file/${segment.id}${download ? '?download=true' : ''}`);
}

// Кадр дорожки на момент времени — превью в лупе таймлайна
export function frameUrl(track: Track, ms: number): string {
    const query = `camera=${encodeURIComponent(track.camera_id)}`
        + `&stream=${encodeURIComponent(track.stream_key)}`
        + `&ms=${Math.round(ms)}`;
    return storagePath(track.device_id, `/api/archive/frame?${query}`);
}

// ── ключи и подписи ──

export const trackKey = (track: Track) =>
    `${track.device_id}/${track.camera_id}/${track.stream_key}`;

// Подпись дорожки: имя камеры, а когда у камеры пишется несколько потоков — с номером канала
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

// Ключ суток YYYY-MM-DD из миллисекунд времени изделия
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

// Короткая длительность для ячейки календаря: до часа — минуты, дальше часы
export function fmtHoursShort(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes} мин`;
    return `${Math.round(minutes / 60)} ч`;
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

// Доля суток в процентах — позиция на полосе
export const percentOf = (ms: number, dayStart: number) =>
    Math.min(100, Math.max(0, ((ms - dayStart) / DAY_MS) * 100));

export const msAtPercent = (percent: number, dayStart: number) =>
    dayStart + (percent / 100) * DAY_MS;

// Сегмент, внутри которого лежит момент
export function segmentAt(segments: Segment[], ms: number): Segment | null {
    return segments.find(s => s.start_ms <= ms && ms < s.end_ms) || null;
}

// Ближайший сегмент, начинающийся не раньше момента, — куда прыгать через разрыв
export function segmentAfter(segments: Segment[], ms: number): Segment | null {
    return segments.find(s => s.start_ms >= ms) || null;
}

// Кусок на подключённом диске — его можно смотреть и выгружать
export const isAvailable = (run: Run) => run.available !== false;

// Ближайшее начало доступной записи после момента — по кускам, без списка сегментов
export function runAfter(track: Track, ms: number): number | null {
    const run = track.runs.find(r => isAvailable(r) && r.start_ms >= ms);
    return run ? run.start_ms : null;
}

// Можно ли смотреть момент: попадает ли он в доступный кусок
export const isRecorded = (track: Track, ms: number) =>
    track.runs.some(run => isAvailable(run) && run.start_ms <= ms && ms < run.end_ms);

// Имя неподключённого диска, на котором лежит момент; null — момент не на нём
export function goneAt(track: Track, ms: number): string | null {
    const run = track.runs.find(r => !isAvailable(r) && r.start_ms <= ms && ms < r.end_ms);
    return run ? run.disk || 'без имени' : null;
}

function overlap(runs: Run[], from: number, to: number): number {
    return runs.reduce((sum, run) => sum + Math.max(0, Math.min(run.end_ms, to) - Math.max(run.start_ms, from)), 0);
}

// Сколько записи внутри диапазона — то, что реально попадёт в склейку
export const recordedWithin = (track: Track, from: number, to: number) =>
    overlap(track.runs.filter(isAvailable), from, to);

// Сколько записи диапазона лежит на неподключённых дисках — в склейку не войдёт
export const goneWithin = (track: Track, from: number, to: number) =>
    overlap(track.runs.filter(run => !isAvailable(run)), from, to);

// Объединение кусков: перекрывающиеся и смежные сливаются
export function unionRuns(runs: Run[]): Array<{ start_ms: number; end_ms: number }> {
    const sorted = [...runs].sort((a, b) => a.start_ms - b.start_ms);
    const out: Array<{ start_ms: number; end_ms: number }> = [];
    for (const run of sorted) {
        const last = out[out.length - 1];
        if (last && run.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, run.end_ms);
        else out.push({ start_ms: run.start_ms, end_ms: run.end_ms });
    }
    return out;
}

// Вычитание отрезков: что остаётся от base после удаления cut
export function subtractRuns(
    base: Array<{ start_ms: number; end_ms: number }>,
    cut: Array<{ start_ms: number; end_ms: number }>,
): Array<{ start_ms: number; end_ms: number }> {
    return cut.reduce((left, c) => left.flatMap(r => {
        if (r.end_ms <= c.start_ms || r.start_ms >= c.end_ms) return [r];
        const parts = [];
        if (r.start_ms < c.start_ms) parts.push({ start_ms: r.start_ms, end_ms: c.start_ms });
        if (r.end_ms > c.end_ms) parts.push({ start_ms: c.end_ms, end_ms: r.end_ms });
        return parts;
    }), base);
}

// Разрывы, попавшие в диапазон: о них предупреждаем до склейки
export function gapsWithin(track: Track, from: number, to: number): Gap[] {
    return track.gaps.filter(gap => gap.end_ms > from && gap.start_ms < to);
}

// Куски и разрывы уже этой доли окна, идущие подряд, рисуются одним плотным блоком
const DENSE_PERCENT = 0.25;

// Плотный блок: частые разрывы, неразличимые на этом масштабе
export interface Dense {
    start_ms: number;
    end_ms: number;
    gaps: number;
    gap_ms: number;
}

// Что дорожка рисует в окне
export interface Stripes {
    runs: Run[];
    gaps: Gap[];
    dense: Dense[];
}

// Первый элемент, кончающийся после ms: куски и разрывы приходят по порядку и не перекрываются
function firstEndingAfter(items: Array<Run | Gap>, ms: number): number {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (items[mid].end_ms > ms) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

export function trackStripes(track: Track, from: number, to: number): Stripes {
    const out: Stripes = { runs: [], gaps: [], dense: [] };
    const narrow = ((to - from) * DENSE_PERCENT) / 100;
    const isGap = (item: Run | Gap): item is Gap => 'kind' in item;
    const put = (item: Run | Gap) => (isGap(item) ? out.gaps.push(item) : out.runs.push(item));

    // Куски и разрывы окна по порядку начала
    const { runs, gaps } = track;
    let r = firstEndingAfter(runs, from);
    let g = firstEndingAfter(gaps, from);
    const items: Array<Run | Gap> = [];
    for (;;) {
        const run = r < runs.length && runs[r].start_ms < to ? runs[r] : null;
        const gap = g < gaps.length && gaps[g].start_ms < to ? gaps[g] : null;
        if (run && (!gap || run.start_ms <= gap.start_ms)) {
            items.push(run);
            r++;
        } else if (gap) {
            items.push(gap);
            g++;
        } else {
            break;
        }
    }

    let group: Array<Run | Gap> = [];
    const flush = () => {
        const gaps = group.filter(isGap);
        if (group.length > 1 && gaps.length) {
            out.dense.push({
                start_ms: group[0].start_ms,
                end_ms: group[group.length - 1].end_ms,
                gaps: gaps.length,
                gap_ms: gaps.reduce((sum, gap) => sum + gap.end_ms - gap.start_ms, 0),
            });
        } else {
            group.forEach(put);
        }
        group = [];
    };

    for (const item of items) {
        if (item.end_ms - item.start_ms < narrow) {
            group.push(item);
            continue;
        }
        flush();
        put(item);
    }
    flush();

    return out;
}

// Оценка размера куска по средней плотности записи на дорожке
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
    title?: string;
    subtitle?: string;
    files_total?: number;
    files_processed?: number;
    bytes_total?: number;
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

// Что и за какой отрезок выгружаем; tracks — камеры одного устройства
export interface ExportRequest {
    tracks: Array<{ camera: string; stream: string }>;
    from_ms: number;
    to_ms: number;
    title: string;
    subtitle: string;
}

// Склейка: по файлу на дорожку, несколько дорожек уходят архивом
export const startCut = (deviceId: string, request: ExportRequest) =>
    postJson(storagePath(deviceId, '/api/archive/cut'), request);

// Итог удаления на устройстве: deferred — файлы на извлечённых дисках, kept_open — пишущиеся
export interface DeleteResult {
    removed: number;
    bytes: number;
    deferred: number;
    kept_open: number;
}

// Удаление закрытых сегментов дорожек, задетых диапазоном
export async function deleteRange(
    deviceId: string,
    tracks: Array<{ camera: string; stream: string }>,
    fromMs: number,
    toMs: number,
): Promise<DeleteResult> {
    const response = await fetch(storagePath(deviceId, '/api/archive/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks, from_ms: Math.round(fromMs), to_ms: Math.round(toMs) }),
    });
    if (!response.ok) throw new Error((await response.text()) || `${response.status}`);
    return response.json();
}

// Исходные сегменты архивом: zip собирается на лету, качает сам браузер
export function zipUrl(
    deviceId: string,
    tracks: Array<{ camera: string; stream: string }>,
    fromMs: number,
    toMs: number,
): string {
    const params = new URLSearchParams();
    tracks.forEach(track => params.append('track', `${track.camera}:${track.stream}`));
    params.set('from_ms', String(Math.round(fromMs)));
    params.set('to_ms', String(Math.round(toMs)));
    return storagePath(deviceId, `/api/archive/zip?${params.toString()}`);
}

// Скачивание отдаётся браузеру: файл на гигабайты в памяти вкладки не собирается
export function browserDownload(url: string): void {
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// Корень задач склейки на устройстве
export const recordingJobs = (deviceId: string) => storagePath(deviceId, '/api/recordings/jobs');

// Активные задачи по корню — ими восстанавливается список после перезагрузки
export const fetchJobs = (root: string) =>
    getJson<{ jobs: Array<JobProgress & { id: string }> }>(root);

export function jobProgressUrl(root: string, jobId: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${root}/${jobId}/progress`;
}

export const jobDownloadUrl = (root: string, jobId: string) => `${root}/${jobId}/download`;

export const jobCancelUrl = (root: string, jobId: string) => `${root}/${jobId}`;

// ── масштаб таймлайна ──

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Уровень приближения: ширина окна, шаг засечек и то, что писать в подписи
export interface ZoomLevel {
    span: number;
    label: string;
    major: number;
    minor: number;
    fmt: 'date' | 'hm' | 'hms';
}

export const ZOOMS: ZoomLevel[] = [
    { span: 7 * DAY_MS, label: '7 суток',  major: DAY_MS,      minor: 6 * HOUR,   fmt: 'date' },
    { span: 2 * DAY_MS, label: '2 суток',  major: 6 * HOUR,    minor: HOUR,       fmt: 'hm' },
    { span: DAY_MS,     label: 'сутки',    major: 3 * HOUR,    minor: HOUR,       fmt: 'hm' },
    { span: 6 * HOUR,   label: '6 часов',  major: HOUR,        minor: 15 * MINUTE, fmt: 'hm' },
    { span: HOUR,       label: 'час',      major: 10 * MINUTE, minor: 2 * MINUTE, fmt: 'hm' },
    { span: 15 * MINUTE, label: '15 минут', major: 2 * MINUTE, minor: 30 * SECOND, fmt: 'hms' },
    { span: 5 * MINUTE, label: '5 минут',  major: MINUTE,      minor: 15 * SECOND, fmt: 'hms' },
    { span: MINUTE,     label: 'минута',   major: 10 * SECOND, minor: 2 * SECOND, fmt: 'hms' },
];

export const DEFAULT_ZOOM = 3;

export interface Tick {
    ms: number;
    major: boolean;
    label: string | null;
}

const TICK_FMT: Record<ZoomLevel['fmt'], Intl.DateTimeFormatOptions> = {
    date: { timeZone: 'UTC', day: '2-digit', month: '2-digit' },
    hm: { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' },
    hms: { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' },
};

// Подпись засечки: чем крупнее приближение, тем подробнее
export function fmtTick(ms: number, fmt: ZoomLevel['fmt']): string {
    const date = new Date(ms);
    // Полночь подписываем датой на любом масштабе — иначе не видно, где сутки
    if (fmt !== 'date' && ms % DAY_MS === 0) {
        return date.toLocaleDateString('ru-RU', TICK_FMT.date);
    }
    return fmt === 'date'
        ? date.toLocaleDateString('ru-RU', TICK_FMT.date)
        : date.toLocaleTimeString('ru-RU', TICK_FMT[fmt]);
}

// Засечки окна: крупные подписаны, промежуточные только линиями
export function buildTicks(from: number, to: number, level: ZoomLevel): Tick[] {
    const ticks: Tick[] = [];
    const step = level.minor;
    const start = Math.ceil(from / step) * step;

    for (let ms = start; ms <= to; ms += step) {
        const major = ms % level.major === 0;
        ticks.push({ ms, major, label: major ? fmtTick(ms, level.fmt) : null });
    }
    return ticks;
}

// Доля окна в процентах — позиция на полотне
export const percentIn = (ms: number, from: number, to: number) =>
    ((ms - from) / (to - from)) * 100;

export const msAt = (percent: number, from: number, to: number) =>
    from + (percent / 100) * (to - from);

export function fmtDateLong(ms: number): string {
    return new Date(ms).toLocaleDateString('ru-RU', {
        timeZone: 'UTC', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    });
}
