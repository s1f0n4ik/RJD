import type { StreamTile, VideoStream } from '../../features/neural/api/types';

// Геометрия полотна видеопотока — зеркало include/neural/video-stream.h

export interface Rect { x: number; y: number; w: number; h: number }
export interface Cell { r: number; c: number }
export type Crop = [number, number, number, number];
export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';

const MIN_CROP = 0.05;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const weights = (n: number, fr: number[]) => (fr.length === n ? fr : Array.from({ length: n }, () => 1));

/** Границы дорожек в пикселях по весам; последняя граница ровно size */
export function edges(size: number, n: number, fr: number[]): number[] {
    const w = weights(n, fr);
    const total = w.reduce((a, b) => a + b, 0);
    const out = [0];
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += w[i];
        out.push(Math.round((size * acc) / total));
    }
    out[n] = size;
    return out;
}

export function cellRect(s: VideoStream, r: number, c: number, rs = 1, cs = 1): Rect {
    const xs = edges(s.width, s.cols, s.col_fr), ys = edges(s.height, s.rows, s.row_fr);
    return { x: xs[c], y: ys[r], w: xs[c + cs] - xs[c], h: ys[r + rs] - ys[r] };
}

export const tileCell = (s: VideoStream, t: StreamTile) => cellRect(s, t.row, t.col, t.row_span, t.col_span);

/** Область картинки в ячейке; размер кадра камеры неизвестен или растяжение — вся ячейка */
export function tileDst(s: VideoStream, t: StreamTile, camW: number, camH: number): Rect {
    const c = tileCell(s, t);
    if (t.fit === 'stretch' || camW <= 0 || camH <= 0) return c;
    const sw = t.crop[2] * camW, sh = t.crop[3] * camH, k = Math.min(c.w / sw, c.h / sh);
    const w = Math.max(1, Math.floor(sw * k)), h = Math.max(1, Math.floor(sh * k));
    return { x: c.x + Math.floor((c.w - w) / 2), y: c.y + Math.floor((c.h - h) / 2), w, h };
}

export function tileAt(s: VideoStream, r: number, c: number): number {
    return s.tiles.findIndex(t => r >= t.row && r < t.row + t.row_span && c >= t.col && c < t.col + t.col_span);
}

/** Отрезки границы между стыками; внутри объединённой ячейки границы нет */
export function borderRuns(s: VideoStream, vertical: boolean, i: number): [number, number][] {
    const xs = edges(s.width, s.cols, s.col_fr), ys = edges(s.height, s.rows, s.row_fr);
    const n = vertical ? s.rows : s.cols;
    const runs: [number, number][] = [];
    let open: [number, number] | null = null;
    for (let j = 0; j < n; j++) {
        const a = vertical ? tileAt(s, j, i - 1) : tileAt(s, i - 1, j);
        const b = vertical ? tileAt(s, j, i) : tileAt(s, i, j);
        const lo = vertical ? ys[j] : xs[j], hi = vertical ? ys[j + 1] : xs[j + 1];
        if (a < 0 || b < 0 || a !== b) {
            if (open) open[1] = hi;
            else { open = [lo, hi]; runs.push(open); }
        } else open = null;
    }
    return runs;
}

/** Окно с пропорцией ячейки наибольшего размера вокруг центра текущего окна */
export function cropForCell(crop: Crop, cell: Rect, camW: number, camH: number): Crop {
    const ca = cell.w / cell.h, ar = camW / camH;
    const [w, h] = ca >= ar ? [1, ar / ca] : [ca / ar, 1];
    const cx = crop[0] + crop[2] / 2, cy = crop[1] + crop[3] / 2;
    return [clamp(cx - w / 2, 0, 1 - w), clamp(cy - h / 2, 0, 1 - h), w, h];
}

/** Масштаб окна вокруг точки (fx, fy) в долях окна; f > 1 — окно больше */
export function zoomCrop(crop: Crop, f: number, fx: number, fy: number): Crop {
    const [x, y, w, h] = crop;
    let k = f;
    if (k > 1) k = Math.min(k, 1 / w, 1 / h);
    if (k < 1) k = Math.max(k, MIN_CROP / w, MIN_CROP / h);
    const nw = w * k, nh = h * k;
    return [clamp(x + fx * (w - nw), 0, 1 - nw), clamp(y + fy * (h - nh), 0, 1 - nh), nw, nh];
}

/** Край или угол окна в точку (px, py) долей кадра; противоположная сторона стоит */
export function resizeCrop(start: Crop, handle: Handle, px: number, py: number): Crop {
    let x0 = start[0], y0 = start[1], x1 = start[0] + start[2], y1 = start[1] + start[3];
    px = clamp(px, 0, 1);
    py = clamp(py, 0, 1);
    if (handle.includes('w')) x0 = Math.min(px, x1 - MIN_CROP);
    else if (handle.includes('e')) x1 = Math.max(px, x0 + MIN_CROP);
    if (handle.includes('n')) y0 = Math.min(py, y1 - MIN_CROP);
    else if (handle.includes('s')) y1 = Math.max(py, y0 + MIN_CROP);
    return [x0, y0, x1 - x0, y1 - y0];
}

export const moveCrop = (start: Crop, dx: number, dy: number): Crop =>
    [clamp(start[0] + dx, 0, 1 - start[2]), clamp(start[1] + dy, 0, 1 - start[3]), start[2], start[3]];

/** Новое число строк или столбцов: тайлы за краем уходят, спаны обрезаются */
export function resizeGrid(s: VideoStream, rows: number, cols: number): VideoStream {
    const fit = (fr: number[], old: number, n: number) => {
        const w = weights(old, fr).slice(0, n);
        while (w.length < n) w.push(1);
        return w.every(v => v === 1) ? [] : w;
    };
    return {
        ...s,
        rows, cols,
        row_fr: fit(s.row_fr, s.rows, rows),
        col_fr: fit(s.col_fr, s.cols, cols),
        tiles: s.tiles
            .filter(t => t.row < rows && t.col < cols)
            .map(t => ({ ...t, row_span: Math.min(t.row_span, rows - t.row), col_span: Math.min(t.col_span, cols - t.col) })),
    };
}

/** Объединение выбранных ячеек в прямоугольник; null — внутри больше одной камеры или тайл торчит наружу */
export function mergeCells(s: VideoStream, cells: Cell[]): { stream: VideoStream; at: Cell } | null {
    let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
    for (const m of cells) {
        const i = tileAt(s, m.r, m.c);
        const t = i < 0 ? { row: m.r, col: m.c, row_span: 1, col_span: 1 } : s.tiles[i];
        r0 = Math.min(r0, t.row); c0 = Math.min(c0, t.col);
        r1 = Math.max(r1, t.row + t.row_span); c1 = Math.max(c1, t.col + t.col_span);
    }
    const inside = (t: StreamTile) => t.row >= r0 && t.col >= c0 && t.row + t.row_span <= r1 && t.col + t.col_span <= c1;
    const touch = (t: StreamTile) => t.row < r1 && t.row + t.row_span > r0 && t.col < c1 && t.col + t.col_span > c0;
    if (s.tiles.some(t => touch(t) && !inside(t))) return null;
    const keep = s.tiles.filter(inside);
    if (keep.length > 1) return null;
    // Пустой объединённой ячейки у бэка нет — она живёт в тайле, которому камеру назначат позже
    const merged: StreamTile = keep[0]
        ? { ...keep[0], row: r0, col: c0, row_span: r1 - r0, col_span: c1 - c0 }
        : { camera: '', row: r0, col: c0, row_span: r1 - r0, col_span: c1 - c0, crop: [0, 0, 1, 1], fit: 'letterbox' };
    return { stream: { ...s, tiles: [...s.tiles.filter(t => !inside(t)), merged] }, at: { r: r0, c: c0 } };
}

/** Схема для записи: тайлы без камеры — это ещё не назначенные ячейки */
export const withCamerasOnly = (s: VideoStream): VideoStream => ({ ...s, tiles: s.tiles.filter(t => t.camera) });

/** Ячейки сетки, не занятые тайлами */
export function freeCells(s: VideoStream): Cell[] {
    const out: Cell[] = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) if (tileAt(s, r, c) < 0) out.push({ r, c });
    return out;
}
