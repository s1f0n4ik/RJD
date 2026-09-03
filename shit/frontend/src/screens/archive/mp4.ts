// Разбор фрагментного mp4 для плеера на MSE: заголовок, первый moof, индекс mfra

interface Box {
    type: string;
    body: number;
    end: number;
}

export interface InitInfo {
    mime: string;
    // Единицы времени дорожки: в них считаются tfdt и tfra
    timescale: number;
    // Конец ftyp+moov — с этого байта начинаются фрагменты
    initEnd: number;
    // Декодное время первого фрагмента
    firstTime: number;
}

export interface IndexEntry {
    time: number;
    offset: number;
}

export type HeadResult =
    | { kind: 'fragmented'; info: InitInfo }
    // moov в начале не найден или без mvex — обычный прогрессивный mp4
    | { kind: 'plain' }
    // Заголовок длиннее прочитанного — нужно столько байт
    | { kind: 'more'; need: number };

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function fourcc(data: DataView, at: number): string {
    return String.fromCharCode(
        data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3),
    );
}

function boxes(data: DataView, start: number, end: number): Box[] {
    const out: Box[] = [];
    let at = start;

    while (at + 8 <= end) {
        let size = data.getUint32(at);
        let header = 8;

        if (size === 1) {
            if (at + 16 > end) break;
            size = Number(data.getBigUint64(at + 8));
            header = 16;
        } else if (size === 0) {
            size = end - at;
        }
        if (size < header) break;

        out.push({ type: fourcc(data, at + 4), body: at + header, end: Math.min(at + size, end) });
        at += size;
    }
    return out;
}

const child = (data: DataView, box: Box, type: string) =>
    boxes(data, box.body, box.end).find(b => b.type === type) ?? null;

function descend(data: DataView, box: Box, path: string[]): Box | null {
    let at: Box | null = box;
    for (const type of path) {
        if (!at) return null;
        at = child(data, at, type);
    }
    return at;
}

const hex = (value: number) => value.toString(16).padStart(2, '0');

function avcCodec(data: DataView, avcC: Box): string {
    const at = avcC.body;
    return `avc1.${hex(data.getUint8(at + 1))}${hex(data.getUint8(at + 2))}${hex(data.getUint8(at + 3))}`;
}

// Строка кодека HEVC по ISO/IEC 14496-15, как её ждёт isTypeSupported
function hevcCodec(data: DataView, hvcC: Box, type: string): string {
    const at = hvcC.body;
    const byte = data.getUint8(at + 1);
    const space = byte >> 6;
    const tier = (byte >> 5) & 1;
    const profile = byte & 0x1f;

    let compat = data.getUint32(at + 2);
    let reversed = 0;
    for (let i = 0; i < 32; i++) {
        reversed = (reversed << 1) | (compat & 1);
        compat >>>= 1;
    }

    const constraints: string[] = [];
    for (let i = 0; i < 6; i++) constraints.push(hex(data.getUint8(at + 6 + i)));
    while (constraints.length && constraints[constraints.length - 1] === '00') constraints.pop();

    const level = data.getUint8(at + 12);
    const parts = [
        `${['', 'A', 'B', 'C'][space]}${profile}`,
        (reversed >>> 0).toString(16).toUpperCase(),
        `${tier ? 'H' : 'L'}${level}`,
        ...constraints.map(c => c.toUpperCase()),
    ];
    return `${type}.${parts.join('.')}`;
}

function codecOf(data: DataView, stsd: Box): string | null {
    // stsd: версия и флаги, число записей, дальше записи-коробки
    const entry = boxes(data, stsd.body + 8, stsd.end)[0];
    if (!entry) return null;

    // Визуальная запись: 78 байт полей, потом дочерние коробки
    const inner = boxes(data, entry.body + 78, entry.end);
    const avcC = inner.find(b => b.type === 'avcC');
    if (avcC) return avcCodec(data, avcC);
    const hvcC = inner.find(b => b.type === 'hvcC');
    if (hvcC) return hevcCodec(data, hvcC, entry.type);
    return null;
}

function tfdtOf(data: DataView, moof: Box): number | null {
    const tfdt = descend(data, moof, ['traf', 'tfdt']);
    if (!tfdt) return null;
    return data.getUint8(tfdt.body) === 1
        ? Number(data.getBigUint64(tfdt.body + 4))
        : data.getUint32(tfdt.body + 4);
}

export function parseHead(bytes: Uint8Array): HeadResult {
    const data = view(bytes);
    const top = boxes(data, 0, bytes.length);

    const moovIndex = top.findIndex(b => b.type === 'moov');
    if (moovIndex < 0) return { kind: 'plain' };

    const moov = top[moovIndex];
    // Размер коробки известен из заголовка, даже когда тело не дочитано
    const moovSize = data.getUint32(moov.body - 8);
    if (moov.body - 8 + moovSize > bytes.length) return { kind: 'more', need: moov.body - 8 + moovSize };

    if (!child(data, moov, 'mvex')) return { kind: 'plain' };

    const trak = child(data, moov, 'trak');
    const mdhd = trak && descend(data, trak, ['mdia', 'mdhd']);
    const stsd = trak && descend(data, trak, ['mdia', 'minf', 'stbl', 'stsd']);
    if (!trak || !mdhd || !stsd) return { kind: 'plain' };

    const timescale = data.getUint32(mdhd.body + (data.getUint8(mdhd.body) === 1 ? 20 : 12));
    const codec = codecOf(data, stsd);
    if (!codec || !timescale) return { kind: 'plain' };

    const moof = top.slice(moovIndex + 1).find(b => b.type === 'moof');
    if (!moof) return { kind: 'more', need: bytes.length * 2 };
    const moofSize = data.getUint32(moof.body - 8);
    if (moof.body - 8 + moofSize > bytes.length) return { kind: 'more', need: moof.body - 8 + moofSize };

    const firstTime = tfdtOf(data, moof);
    if (firstTime === null) return { kind: 'plain' };

    return {
        kind: 'fragmented',
        info: { mime: `video/mp4; codecs="${codec}"`, timescale, initEnd: moov.end, firstTime },
    };
}

// Записи tfra из хвоста файла: время и смещение moof для каждого ключевого кадра.
// tail — последние байты файла, начиная с tailStart; пустой список — индекса нет
export function parseTail(tail: Uint8Array, tailStart: number, total: number): IndexEntry[] {
    const n = tail.length;
    if (n < 16) return [];

    const data = view(tail);
    if (fourcc(data, n - 12) !== 'mfro') return [];

    const mfraSize = data.getUint32(n - 4);
    const mfraStart = total - mfraSize;
    if (mfraStart < tailStart) return [];

    const at = mfraStart - tailStart;
    if (fourcc(data, at + 4) !== 'mfra') return [];

    const tfra = child(data, { type: 'mfra', body: at + 8, end: n }, 'tfra');
    if (!tfra) return [];

    const wide = data.getUint8(tfra.body) === 1;
    const flags = data.getUint32(tfra.body + 8);
    const extra = (((flags >> 4) & 3) + 1) + (((flags >> 2) & 3) + 1) + ((flags & 3) + 1);
    const count = data.getUint32(tfra.body + 12);

    const entries: IndexEntry[] = [];
    let cursor = tfra.body + 16;
    const word = wide ? 8 : 4;

    for (let i = 0; i < count && cursor + 2 * word + extra <= tfra.end; i++) {
        const time = wide ? Number(data.getBigUint64(cursor)) : data.getUint32(cursor);
        const offset = wide ? Number(data.getBigUint64(cursor + word)) : data.getUint32(cursor + word);
        entries.push({ time, offset });
        cursor += 2 * word + extra;
    }
    return entries;
}

// Общий размер ресурса из Content-Range: bytes a-b/total
export function totalOf(response: Response, fallback: number): number {
    const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
    return match ? Number(match[1]) : fallback;
}

export async function fetchRange(
    url: string, start: number, end: number, signal: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; total: number }> {
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    // Сервер без Range отдаёт файл целиком — это и есть его размер
    return { bytes, total: totalOf(response, response.status === 200 ? bytes.length : start + bytes.length) };
}

// Потоковое чтение диапазона: куски уходят в onChunk по мере прихода
export async function fetchStream(
    url: string, start: number, end: number, signal: AbortSignal,
    onChunk: (chunk: Uint8Array<ArrayBuffer>) => void,
): Promise<void> {
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('empty body');

    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) onChunk(value);
    }
}
