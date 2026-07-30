import type { LinkerExportDetail, LinkerOverlay, LinkerPlace } from '../../api/linker';

/**
 * Геометрия схемы назначения камер.
 *
 * Места камер приходят прямоугольниками в координатах канваса. Здесь они
 * приводятся к системе экрана. Нахлёсты соседей режутся диагональными швами,
 * как в реальной склейке кругового обзора: каждая камера получает свою
 * половину зоны пересечения, между половинами остаётся зазор-шов.
 */

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Pt {
    x: number;
    y: number;
}

export interface PlanTile {
    key: string;
    /** Имя места из пресета — то, что видит оператор вместо ключа. */
    name: string;
    /** След камеры на канвасе до разводки швов. */
    rect: Rect;
    /** Контур места после срезов по швам — трапеция при нахлёстах. */
    poly: Pt[];
    /** Центр тяжести контура — точка подписи. */
    center: Pt;
}

/** Подложка конфигурации: габарит с именем файла. */
export interface PlanOverlay {
    name: string;
    rect: Rect;
}

/** Значок камеры на периметре машины, взгляд — на центр места. */
export interface PlanIcon {
    key: string;
    x: number;
    y: number;
    /** Направление взгляда, градусы; 0 — вправо по экрану. */
    angleDeg: number;
}

export interface PlanGeometry {
    /** Размер сцены в экранных координатах — viewBox для svg. */
    view: { width: number; height: number };
    /** Канвас вертикальный и был положен на бок. */
    rotated: boolean;
    tiles: PlanTile[];
    overlays: PlanOverlay[];
    /** Габарит машины из конфигуратора; null у записей без него. */
    machine: Rect | null;
    /** Значки камер; пусты у записей без габарита. */
    icons: PlanIcon[];
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

function rectPoly(r: Rect): Pt[] {
    return [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
    ];
}

function rectCenter(r: Rect): Pt {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function overlapRect(a: Rect, b: Rect): Rect | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 - x <= 0 || y2 - y <= 0) return null;
    return { x, y, w: x2 - x, h: y2 - y };
}

/** Шов — та диагональ нахлёста, что смотрит от машины наружу. */
function seamDiagonal(ov: Rect, anchor: Pt): [Pt, Pt] {
    const c = rectCenter(ov);
    const dirX = c.x - anchor.x;
    const dirY = c.y - anchor.y;

    const d1: [Pt, Pt] = [{ x: ov.x, y: ov.y }, { x: ov.x + ov.w, y: ov.y + ov.h }];
    const d2: [Pt, Pt] = [{ x: ov.x, y: ov.y + ov.h }, { x: ov.x + ov.w, y: ov.y }];

    const align = (d: [Pt, Pt]) =>
        Math.abs((d[1].x - d[0].x) * dirX + (d[1].y - d[0].y) * dirY);
    return align(d1) >= align(d2) ? d1 : d2;
}

/**
 * Срезает у контура половину за швом, отступив в полшва к своей стороне —
 * так между соседями остаётся видимый зазор.
 *
 * Шов режет полуплоскостью: у реальных раскладок линия шва за пределами
 * нахлёста в контур уже не попадает. Выродившийся срез отбрасывается.
 */
function clipBySeam(poly: Pt[], a: Pt, b: Pt, keepPt: Pt, inset: number): Pt[] {
    let ux = -(b.y - a.y);
    let uy = b.x - a.x;
    const len = Math.hypot(ux, uy);
    if (!len) return poly;
    ux /= len;
    uy /= len;

    // Нормаль разворачивается к сохраняемой стороне
    const side = ux * (keepPt.x - a.x) + uy * (keepPt.y - a.y);
    if (side === 0) return poly;
    if (side < 0) {
        ux = -ux;
        uy = -uy;
    }

    const ax = a.x + ux * inset;
    const ay = a.y + uy * inset;
    const val = (p: Pt) => ux * (p.x - ax) + uy * (p.y - ay);

    const out: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
        const cur = poly[i];
        const nxt = poly[(i + 1) % poly.length];
        const vc = val(cur);
        const vn = val(nxt);
        if (vc >= 0) out.push(cur);
        if (vc >= 0 !== vn >= 0) {
            const t = vc / (vc - vn);
            out.push({ x: cur.x + (nxt.x - cur.x) * t, y: cur.y + (nxt.y - cur.y) * t });
        }
    }
    return out.length >= 3 ? out : poly;
}

function polyCentroid(poly: Pt[]): Pt {
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const n = poly[(i + 1) % poly.length];
        const cross = p.x * n.y - n.x * p.y;
        area += cross;
        cx += (p.x + n.x) * cross;
        cy += (p.y + n.y) * cross;
    }
    if (!area) return poly[0] ?? { x: 0, y: 0 };
    return { x: cx / (3 * area), y: cy / (3 * area) };
}

/** Ближайшая точка периметра прямоугольника к произвольной точке. */
function nearestOnPerimeter(p: Pt, g: Rect): Pt {
    const inX = p.x > g.x && p.x < g.x + g.w;
    const inY = p.y > g.y && p.y < g.y + g.h;
    if (!inX || !inY) {
        return {
            x: Math.max(g.x, Math.min(g.x + g.w, p.x)),
            y: Math.max(g.y, Math.min(g.y + g.h, p.y)),
        };
    }

    const dl = p.x - g.x;
    const dr = g.x + g.w - p.x;
    const dt = p.y - g.y;
    const db = g.y + g.h - p.y;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: g.x, y: p.y };
    if (m === dr) return { x: g.x + g.w, y: p.y };
    if (m === dt) return { x: p.x, y: g.y };
    return { x: p.x, y: g.y + g.h };
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
            machine: null,
            icons: [],
            missing,
        };
    }

    const rotated = height > width;
    const view = rotated ? { width: height, height: width } : { width, height };

    const rects = withRect.map(p => lay(p.rect, rotated));
    const machine = detail.machineRect ? lay(detail.machineRect, rotated) : null;

    // Ось «изнутри наружу» для выбора диагонали шва
    const anchor = machine ? rectCenter(machine) : { x: view.width / 2, y: view.height / 2 };
    const seam = Math.max(view.width, view.height) * 0.006;

    const polys = rects.map(rectPoly);
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            const ov = overlapRect(rects[i], rects[j]);
            if (!ov) continue;
            const [a, b] = seamDiagonal(ov, anchor);
            polys[i] = clipBySeam(polys[i], a, b, rectCenter(rects[i]), seam / 2);
            polys[j] = clipBySeam(polys[j], a, b, rectCenter(rects[j]), seam / 2);
        }
    }

    const icons: PlanIcon[] = machine
        ? withRect.map((p, i) => {
            const c = rectCenter(rects[i]);
            const pt = nearestOnPerimeter(c, machine);
            const dx = c.x - pt.x;
            const dy = c.y - pt.y;
            // Центр места лёг на периметр — взгляд наружу от центра машины
            const deg = dx || dy
                ? (Math.atan2(dy, dx) * 180) / Math.PI
                : (Math.atan2(pt.y - anchor.y, pt.x - anchor.x) * 180) / Math.PI;
            return { key: p.key, x: pt.x, y: pt.y, angleDeg: deg };
        })
        : [];

    return {
        view,
        rotated,
        tiles: withRect.map((p, i) => ({
            key: p.key,
            name: p.name || p.key,
            rect: rects[i],
            poly: polys[i],
            center: polyCentroid(polys[i]),
        })),
        overlays: detail.images.map((img: LinkerOverlay) => ({
            name: img.name,
            rect: lay(img.rect, rotated),
        })),
        machine,
        icons,
        missing,
    };
}
