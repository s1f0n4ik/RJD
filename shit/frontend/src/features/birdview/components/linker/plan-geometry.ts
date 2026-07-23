import type { LinkerExportDetail, LinkerOverlay, LinkerPlace } from '../../api/linker';

/**
 * Геометрия схемы назначения камер.
 *
 * Места камер приходят прямоугольниками в координатах канваса. Здесь они
 * приводятся к системе экрана. Пересечения не разводятся: соседние камеры
 * перекрываются по построению, и нахлёст — часть правды о раскладке.
 */

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PlanTile {
    key: string;
    /** Имя места из пресета — то, что видит оператор вместо ключа. */
    name: string;
    /** След камеры на канвасе, с нахлёстом на соседей — как оно и есть. */
    rect: Rect;
}

/** Подложка конфигурации: габарит с именем файла. */
export interface PlanOverlay {
    name: string;
    rect: Rect;
}

export interface PlanGeometry {
    /** Размер сцены в экранных координатах — viewBox для svg. */
    view: { width: number; height: number };
    /** Канвас вертикальный и был положен на бок. */
    rotated: boolean;
    tiles: PlanTile[];
    overlays: PlanOverlay[];
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

export function buildGeometry(detail: LinkerExportDetail): PlanGeometry | null {
    const { width, height } = detail.canvas;
    if (width <= 0 || height <= 0) return null;

    const withRect = detail.places.filter((p): p is LinkerPlace & { rect: Rect } => p.rect !== null);
    const missing = detail.places.filter(p => p.rect === null).map(p => p.name || p.key);

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

    const rects = withRect.map(p => lay(p.rect, rotated));

    return {
        view: rotated ? { width: height, height: width } : { width, height },
        rotated,
        tiles: withRect.map((p, i) => ({
            key: p.key,
            name: p.name || p.key,
            rect: rects[i],
        })),
        overlays: detail.images.map((img: LinkerOverlay) => ({
            name: img.name,
            rect: lay(img.rect, rotated),
        })),
        missing,
    };
}
