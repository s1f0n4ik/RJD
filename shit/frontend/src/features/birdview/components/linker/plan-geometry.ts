import type { LinkerExportDetail, LinkerOverlay, LinkerPlace } from '../../api/linker';

/**
 * Геометрия схемы назначения камер.
 *
 * Места камер приходят прямоугольниками в координатах канваса. Здесь они
 * приводятся к системе экрана и разводятся так, чтобы по ним можно было
 * попадать мышью.
 */

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PlanTile {
    key: string;
    /** Настоящий след камеры на канвасе, с нахлёстом на соседей. */
    real: Rect;
    /** Тот же след после развода пересечений — по нему рисуем и попадаем. */
    tile: Rect;
}

export interface PlanGeometry {
    /** Размер сцены в экранных координатах — viewBox для svg. */
    view: { width: number; height: number };
    /** Канвас вертикальный и был положен на бок. */
    rotated: boolean;
    tiles: PlanTile[];
    overlays: Rect[];
    /** Ключи камер, для которых сервер не прислал region. */
    missing: string[];
}

/**
 * Канвас склейки обычно вытянут вертикально (570×1850 у тягача), а экраны
 * широкие. Вписанный как есть, он даёт полосу шириной сотню пикселей, в
 * которую не ткнуть. Поэтому при вертикальном канвасе меняем оси местами.
 */
function lay(rect: Rect, rotated: boolean): Rect {
    return rotated ? { x: rect.y, y: rect.x, w: rect.h, h: rect.w } : { ...rect };
}

/**
 * Развод пересечений делением пополам.
 *
 * Сдвигать прямоугольники нельзя: место уедет туда, где камеры нет, и схема
 * начнёт врать ровно в том, ради чего её рисуют. Поэтому соседи отдают друг
 * другу по половине общей полосы и смыкаются по общему ребру — позиция
 * сохраняется, а шов проходит по середине реальной зоны смешивания.
 */
function deoverlap(rects: Rect[]): Rect[] {
    const out = rects.map(r => ({ ...r }));

    // Несколько проходов: правка одной пары меняет картину для соседних
    for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < out.length; i++) {
            for (let j = i + 1; j < out.length; j++) {
                const a = out[i];
                const b = out[j];

                const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
                const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                if (ox <= 0 || oy <= 0) continue;

                if (ox < oy) {
                    const mid = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
                    const left = a.x + a.w / 2 <= b.x + b.w / 2 ? a : b;
                    const right = left === a ? b : a;
                    left.w = Math.max(1, mid - left.x);
                    right.w = Math.max(1, right.x + right.w - mid);
                    right.x = mid;
                } else {
                    const mid = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
                    const top = a.y + a.h / 2 <= b.y + b.h / 2 ? a : b;
                    const bottom = top === a ? b : a;
                    top.h = Math.max(1, mid - top.y);
                    bottom.h = Math.max(1, bottom.y + bottom.h - mid);
                    bottom.y = mid;
                }
            }
        }
    }

    return out;
}

export function buildGeometry(detail: LinkerExportDetail): PlanGeometry | null {
    const { width, height } = detail.canvas;
    if (width <= 0 || height <= 0) return null;

    const withRect = detail.places.filter((p): p is LinkerPlace & { rect: Rect } => p.rect !== null);
    const missing = detail.places.filter(p => p.rect === null).map(p => p.key);

    if (withRect.length === 0) {
        return {
            view: { width, height },
            rotated: false,
            tiles: [],
            overlays: [],
            missing,
        };
    }

    const rotated = height > width;

    const real = withRect.map(p => lay(p.rect, rotated));
    const tiles = deoverlap(real);

    return {
        view: rotated ? { width: height, height: width } : { width, height },
        rotated,
        tiles: withRect.map((p, i) => ({ key: p.key, real: real[i], tile: tiles[i] })),
        overlays: detail.images.map((img: LinkerOverlay) => lay(img.rect, rotated)),
        missing,
    };
}
