import type { Segment } from './model';
import { dateKey, dayStartMs, fmtTime, segmentAfter } from './model';
import type { IndexEntry, InitInfo } from './mp4';
import { fetchRange, fetchStream, parseHead, parseTail } from './mp4';

// Лента архива поверх MediaSource: файлы читаются кусками по ключевым кадрам,
// сегменты идут друг за другом в одном буфере, разрывы перепрыгиваются

const HEAD_BYTES = 65_536;
const TAIL_BYTES = 65_536;
// Сколько секунд держать в буфере впереди курсора
const AHEAD_SEC = 20;
// При каком запасе впереди тянуть дальше
const LEAD_SEC = 8;
// Сколько секунд позади курсора оставлять
const KEEP_BEHIND_SEC = 90;
// Дальше этого впереди курсора буфер не нужен
const KEEP_AHEAD_SEC = 150;
// Потолок длительности MediaSource — дальше него currentTime не ставится
const DURATION_SEC = 60 * 86_400;
// Сколько раз повторять append после переполнения буфера
const QUOTA_RETRIES = 2;

interface FileMeta {
    info: InitInfo | null;
    init: Uint8Array<ArrayBuffer>;
    entries: IndexEntry[];
    total: number;
}

interface Cursor {
    segment: Segment;
    meta: FileMeta;
    // Байт, с которого продолжать, и время в этой точке в часах tfra
    pos: number;
    time: number;
    // Область в медиа-секундах, которую грузит этот курсор: начало и докуда дошли
    startSec: number;
    untilSec: number;
}

export interface FeedEvents {
    onError: (message: string) => void;
    // Данные кончились и дальше сегментов нет
    onEnd: () => void;
}

const log = (...parts: unknown[]) => console.info('[archive]', ...parts);

// Сосед по порядку, а не по времени: конец сегмента считается по длительности
// фрагмента, начало следующего по событию открытия, и они перекрываются на миллисекунды
const nextSegment = (list: Segment[], current: Segment): Segment | null =>
    list.find(s => s.start_ms > current.start_ms && s.path !== current.path) ?? null;

export class ArchiveFeed {
    private source: MediaSource | null = null;
    private buffer: SourceBuffer | null = null;
    private mime = '';
    private objectUrl = '';
    // Момент архива, соответствующий нулю медиа-времени
    private origin = 0;
    private ops: Array<() => void> = [];
    private aborter: AbortController | null = null;
    private busy = false;
    private cursor: Cursor | null = null;
    // Последний сегмент, поставленный в буфер, — от него ищется следующий
    private last: Segment | null = null;
    // Прогрессивный файл на очереди: играет через src, когда буфер доиграет
    private pendingPlain: Segment | null = null;
    // Файл, играющий через src, минуя MediaSource
    private plain: Segment | null = null;
    private segments: Segment[] = [];
    private metas = new Map<string, FileMeta>();
    private seq = 0;
    private ended = false;
    // Идёт перемотка: докачка и подстановка следующего файла ждут её конца
    private seeking = false;
    private quotaRetries = 0;
    private video: HTMLVideoElement;
    private urlOf: (segment: Segment) => string;
    private events: FeedEvents;

    constructor(video: HTMLVideoElement, urlOf: (segment: Segment) => string, events: FeedEvents) {
        this.video = video;
        this.urlOf = urlOf;
        this.events = events;
    }

    setSegments(list: Segment[]) {
        this.segments = list;
        // Сегменты подъехали позже, чем кончились данные — продолжаем
        if (!this.cursor && !this.busy && !this.seeking && !this.plain && this.last) {
            const next = nextSegment(list, this.last);
            if (next) {
                log('segments arrived, continue with', next.file);
                void this.continueWith(next, this.seq).then(() => this.maybeStep());
            }
        }
    }

    // Позиция курсора в архиве; null, пока лента ничего не поставила —
    // сброс элемента через load() тоже даёт timeupdate, и он не про архив
    positionMs(): number | null {
        if (this.plain) return this.plain.start_ms + this.video.currentTime * 1000;
        if (!this.source || !this.last) return null;
        return this.origin + this.video.currentTime * 1000;
    }

    // Остановить загрузку и погасить кадр: под курсором записи нет
    park() {
        log('park');
        this.stopLoading();
        this.video.pause();
    }

    async seek(segment: Segment, ms: number) {
        const seq = ++this.seq;
        log(`seek #${seq} ${segment.file} @ ${fmtTime(ms)}`);
        this.stopLoading();
        this.seeking = true;
        try {
            await this.seekInner(segment, ms, seq);
        } finally {
            if (seq === this.seq) this.seeking = false;
        }
        if (seq === this.seq) this.maybeStep();
    }

    private async seekInner(segment: Segment, ms: number, seq: number) {
        let meta: FileMeta;
        try {
            meta = await this.load(segment, seq);
        } catch (e) {
            if (seq === this.seq) this.fail(String(e));
            return;
        }
        if (seq !== this.seq) return;

        if (!meta.info) {
            this.playPlain(segment, ms);
            return;
        }

        this.plain = null;
        // Элемент с выставленным error мёртв: буфер к нему больше не принимает данных
        if (
            !this.source || this.video.error || this.video.src !== this.objectUrl
            || segment.start_ms < this.origin
        ) {
            await this.openSource(segment);
            if (seq !== this.seq) return;
        }
        if (!this.ensureBuffer(meta.info.mime)) return;

        const t = (ms - this.origin) / 1000;

        // Часы tfra абсолютные, tfdt в файле считается от нуля — ищем в часах tfra
        const { info } = meta;
        const base = meta.entries.length ? meta.entries[0].time : info.firstTime;
        const target = base + ((ms - segment.start_ms) / 1000) * info.timescale;
        let pos = info.initEnd;
        let time = base;
        for (const entry of meta.entries) {
            if (entry.time > target) break;
            pos = entry.offset;
            time = entry.time;
        }

        const fileBase = (segment.start_ms - this.origin) / 1000;
        const startSec = fileBase + (time - base) / info.timescale;
        this.startFile(segment, meta);
        // Область курсора сразу накрывает цель: ключевой кадр может быть на GOP раньше неё
        this.cursor = { segment, meta, pos, time, startSec, untilSec: Math.max(startSec, t) };
        this.last = segment;

        // Без метаданных элемент лишь запоминает стартовую позицию и не шлёт seeked
        if (this.video.readyState === 0) {
            await this.untilMetadata();
            if (seq !== this.seq) return;
        }
        log(`seek #${seq} -> media ${t.toFixed(2)}s, keyframe at ${startSec.toFixed(2)}s, byte ${pos}`);
        this.video.currentTime = t;
    }

    // Вызывается на timeupdate и waiting
    tick(playing: boolean) {
        this.maybeStep();
        if (this.plain || !this.buffer) return;

        const t = this.video.currentTime;
        const ranges = this.video.buffered;
        const buffer = this.buffer;

        if (ranges.length && ranges.start(0) < t - KEEP_BEHIND_SEC - 30) {
            this.enqueue(() => buffer.remove(0, t - KEEP_BEHIND_SEC));
        }
        if (ranges.length && ranges.end(ranges.length - 1) > t + KEEP_AHEAD_SEC + 30) {
            this.enqueue(() => buffer.remove(t + KEEP_AHEAD_SEC, DURATION_SEC));
        }

        // Плеер упёрся в конец буфера, а лента простаивает: всё, что могло прийти,
        // уже в буфере — дальше либо разрыв, либо конец
        const idle = !this.busy && !this.seeking && !this.ops.length && !buffer.updating;
        if (!playing || !idle || !this.atRangeEnd(t)) return;

        const next = this.nextRangeStart(t);
        if (next !== null) {
            log(`gap jump ${t.toFixed(2)}s -> ${next.toFixed(2)}s`);
            this.video.currentTime = next + 0.05;
            return;
        }

        if (this.pendingPlain) {
            const segment = this.pendingPlain;
            this.pendingPlain = null;
            void this.seek(segment, segment.start_ms);
            return;
        }

        // Данные кончились раньше, чем ждал курсор: конец файла в индексе оценён
        // короче настоящего. Привязываемся заново к следующему сегменту
        if (this.cursor && t > this.cursor.untilSec + 1) {
            const after = segmentAfter(this.segments, this.origin + t * 1000);
            if (after) {
                log(`re-anchor at ${t.toFixed(2)}s -> ${after.file}`);
                void this.seek(after, after.start_ms);
                return;
            }
        }

        if (!this.cursor && !this.ended) {
            log('end of data');
            this.ended = true;
            this.events.onEnd();
        }
    }

    // Конец файла в режиме src: дальше по списку
    onEnded() {
        if (!this.plain) return;
        const next = nextSegment(this.segments, this.plain);
        if (next) void this.seek(next, next.start_ms);
        else this.events.onEnd();
    }

    destroy() {
        this.seq++;
        this.stopLoading();
        this.closeSource();
    }

    // ── загрузка ──

    private async load(segment: Segment, seq: number): Promise<FileMeta> {
        const cached = this.metas.get(segment.path);
        if (cached) return cached;

        const url = this.urlOf(segment);
        const aborter = new AbortController();
        this.aborter = aborter;

        let head = await fetchRange(url, 0, HEAD_BYTES - 1, aborter.signal);
        let parsed = parseHead(head.bytes);
        while (parsed.kind === 'more') {
            head = await fetchRange(url, 0, parsed.need - 1, aborter.signal);
            parsed = parseHead(head.bytes);
        }
        if (seq !== this.seq) throw new Error('superseded');

        let meta: FileMeta;
        if (parsed.kind === 'plain') {
            meta = { info: null, init: new Uint8Array(0), entries: [], total: head.total };
            log(`open ${segment.file}: progressive mp4, ${head.total} bytes`);
        } else {
            const { info } = parsed;
            const tailStart = Math.max(info.initEnd, head.total - TAIL_BYTES);
            const tail = await fetchRange(url, tailStart, head.total - 1, aborter.signal);
            meta = {
                info,
                init: head.bytes.slice(0, info.initEnd),
                entries: parseTail(tail.bytes, tailStart, head.total),
                total: head.total,
            };
            log(`open ${segment.file}: ${info.mime}, ${head.total} bytes, ${meta.entries.length} keyframes`);
        }

        // Пишущийся файл растёт, его индекс не запоминаем
        if (segment.closed) this.metas.set(segment.path, meta);
        return meta;
    }

    private async step() {
        if (this.busy || this.seeking || !this.cursor || !this.buffer) return;

        const cursor = this.cursor;
        const { info } = cursor.meta;
        if (!info) return;

        const seq = this.seq;
        const aborter = new AbortController();
        this.aborter = aborter;
        this.busy = true;

        const limit = cursor.time + AHEAD_SEC * info.timescale;
        const next = cursor.meta.entries.find(entry => entry.offset > cursor.pos && entry.time > limit);
        const end = next ? next.offset : cursor.meta.total;
        log(`step ${cursor.segment.file} bytes ${cursor.pos}-${end - 1}`);

        try {
            if (cursor.pos < end) {
                // Кусок, дочитанный в один тик с обрывом, в буфер не идёт: он не с ключевого кадра
                await fetchStream(
                    this.urlOf(cursor.segment), cursor.pos, end - 1, aborter.signal,
                    chunk => { if (seq === this.seq && !aborter.signal.aborted) this.append(chunk); },
                );
            }
        } catch (e) {
            if (seq === this.seq) {
                this.busy = false;
                this.fail(String(e));
            }
            return;
        }
        if (seq !== this.seq) return;
        this.busy = false;

        const base = cursor.meta.entries.length ? cursor.meta.entries[0].time : info.firstTime;
        const fileBase = (cursor.segment.start_ms - this.origin) / 1000;

        if (next) {
            cursor.pos = end;
            cursor.time = next.time;
            cursor.untilSec = fileBase + (next.time - base) / info.timescale;
        } else {
            const untilSec = (cursor.segment.end_ms - this.origin) / 1000;
            this.cursor = null;
            const after = nextSegment(this.segments, cursor.segment);
            if (after) {
                await this.continueWith(after, seq, cursor.startSec, untilSec);
                if (seq !== this.seq) return;
            } else {
                log(`file done ${cursor.segment.file}, no next segment yet`);
            }
        }
        this.maybeStep();
    }

    // Следующий сегмент встаёт в тот же буфер со своим смещением времени
    private async continueWith(segment: Segment, seq: number, startSec?: number, untilSec?: number) {
        let meta: FileMeta;
        try {
            meta = await this.load(segment, seq);
        } catch (e) {
            if (seq === this.seq) this.fail(String(e));
            return;
        }
        if (seq !== this.seq) return;

        if (!meta.info) {
            log(`next file ${segment.file} is progressive, will switch to src`);
            this.pendingPlain = segment;
            return;
        }
        if (!this.ensureBuffer(meta.info.mime)) return;

        const fileBase = (segment.start_ms - this.origin) / 1000;
        log(`continue with ${segment.file} at media ${fileBase.toFixed(2)}s`);
        this.startFile(segment, meta);
        this.cursor = {
            segment,
            meta,
            pos: meta.info.initEnd,
            time: meta.entries.length ? meta.entries[0].time : meta.info.firstTime,
            startSec: startSec ?? fileBase,
            untilSec: untilSec ?? fileBase,
        };
        this.last = segment;
    }

    // Докачка нужна только там, где играет плеер: если он в другом месте, шаг бессмыслен
    private maybeStep() {
        const cursor = this.cursor;
        if (this.busy || this.seeking || !cursor) return;

        const t = this.video.currentTime;
        if (t < cursor.startSec - 1 || t > cursor.untilSec + 1) return;
        if (cursor.untilSec - t < LEAD_SEC) void this.step();
    }

    private stopLoading() {
        this.aborter?.abort();
        this.aborter = null;
        this.busy = false;
        this.cursor = null;
        this.ops.length = 0;
        this.pendingPlain = null;
        this.ended = false;
        this.quotaRetries = 0;
        this.resetParser();
    }

    // Парсер буфера мог остаться посреди коробки: следующий init-сегмент он бы счёл ошибкой
    private resetParser() {
        if (this.buffer && this.source?.readyState === 'open') {
            try { this.buffer.abort(); } catch { /* буфер уже отвязан */ }
        }
    }

    private fail(message: string) {
        const media = this.video.error;
        const text = media?.message ? `${message} · ${media.message}` : message;
        log('error:', text, 'buffered:', this.bufferedText());
        this.events.onError(text);
    }

    // ── MediaSource ──

    private async openSource(segment: Segment) {
        this.closeSource();
        this.origin = dayStartMs(dateKey(segment.start_ms));
        log(`open MediaSource, origin ${dateKey(this.origin)}`);

        const source = new MediaSource();
        this.source = source;
        this.objectUrl = URL.createObjectURL(source);
        this.video.src = this.objectUrl;

        await new Promise<void>(resolve => source.addEventListener('sourceopen', () => resolve(), { once: true }));
        source.duration = DURATION_SEC;
    }

    private untilMetadata(): Promise<void> {
        const video = this.video;
        return new Promise(resolve => {
            if (video.readyState > 0) {
                resolve();
                return;
            }
            const done = () => {
                video.removeEventListener('loadedmetadata', done);
                resolve();
            };
            video.addEventListener('loadedmetadata', done);
            // Заголовок не дошёл — не висеть вечно, ошибку покажет сам элемент
            window.setTimeout(done, 5000);
        });
    }

    private closeSource() {
        this.buffer = null;
        this.source = null;
        this.mime = '';
        this.cursor = null;
        this.last = null;
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = '';
        }
        this.video.removeAttribute('src');
        this.video.load();
    }

    private ensureBuffer(mime: string): boolean {
        if (!this.source) return false;
        if (!this.buffer) {
            if (!MediaSource.isTypeSupported(mime)) {
                this.fail(`браузер не играет ${mime}`);
                return false;
            }
            const buffer = this.source.addSourceBuffer(mime);
            buffer.mode = 'segments';
            buffer.addEventListener('updateend', () => this.pump());
            buffer.addEventListener('error', () => this.fail('ошибка буфера'));
            this.buffer = buffer;
            this.mime = mime;
        } else if (this.mime !== mime) {
            this.buffer.changeType(mime);
            this.mime = mime;
        }
        return true;
    }

    private playPlain(segment: Segment, ms: number) {
        this.closeSource();
        this.plain = segment;

        const video = this.video;
        video.src = this.urlOf(segment);
        video.load();

        const offset = Math.max(0, (ms - segment.start_ms) / 1000);
        const apply = () => { video.currentTime = offset; };
        if (video.readyState >= 1) apply();
        else video.addEventListener('loadedmetadata', apply, { once: true });
    }

    private startFile(segment: Segment, meta: FileMeta) {
        const buffer = this.buffer;
        const { info } = meta;
        if (!buffer || !info) return;

        const offset = (segment.start_ms - this.origin) / 1000 - info.firstTime / info.timescale;
        this.enqueue(() => this.resetParser());
        this.enqueue(() => { buffer.timestampOffset = offset; });
        this.enqueue(() => buffer.appendBuffer(meta.init));
    }

    private append(chunk: Uint8Array<ArrayBuffer>) {
        const buffer = this.buffer;
        if (!buffer) return;
        this.enqueue(() => {
            try {
                buffer.appendBuffer(chunk);
                this.quotaRetries = 0;
            } catch (e) {
                if ((e as DOMException).name !== 'QuotaExceededError') throw e;
                // Буфер полон: оставляем полминуты вокруг курсора и пробуем ещё раз
                if (this.quotaRetries++ >= QUOTA_RETRIES) throw e;
                const t = this.video.currentTime;
                log(`quota exceeded at ${t.toFixed(2)}s, buffered ${this.bufferedText()}, retry ${this.quotaRetries}`);
                this.ops.unshift(() => buffer.appendBuffer(chunk));
                this.ops.unshift(() => buffer.remove(t + 30, DURATION_SEC));
                if (t > 31) buffer.remove(0, t - 30);
            }
        });
    }

    // Операции над SourceBuffer идут строго по одной
    private enqueue(op: () => void) {
        this.ops.push(op);
        this.pump();
    }

    private pump() {
        const buffer = this.buffer;
        while (buffer && !buffer.updating && this.ops.length) {
            const op = this.ops.shift()!;
            try {
                op();
            } catch (e) {
                this.ops.length = 0;
                this.fail(String(e));
                return;
            }
        }
    }

    // ── буфер ──

    private atRangeEnd(t: number): boolean {
        const ranges = this.video.buffered;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges.end(i) - 0.3 <= t && t <= ranges.end(i) + 0.5) return true;
        }
        return false;
    }

    private nextRangeStart(t: number): number | null {
        const ranges = this.video.buffered;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges.start(i) > t + 0.5) return ranges.start(i);
        }
        return null;
    }

    private bufferedText(): string {
        const ranges = this.video.buffered;
        const parts: string[] = [];
        for (let i = 0; i < ranges.length; i++) {
            parts.push(`${ranges.start(i).toFixed(1)}-${ranges.end(i).toFixed(1)}`);
        }
        return parts.join(' ') || 'none';
    }
}
