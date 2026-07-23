import { projState } from '../../state/proj-store';
import { CANVAS_COLORS } from '../../styles/canvas-colors';

/**
 * Слой точек warp. Порт canvas.js из no-react с одним принципиальным отличием.
 *
 * В оригинале канвас лежал внутри трансформируемого слоя и при каждом шаге
 * зума пересоздавал bitmap размером base × scale × dpr. На MAX_SCALE = 12 и
 * dpr = 2 это давало 30720×23040 — за пределом Chrome, и канвас молча
 * переставал рисовать.
 *
 * Здесь канвас лежит поверх области фиксированного размера, а зум и сдвиг
 * применяются прямо в отрисовке и в hit-тесте. Bitmap всегда равен размеру
 * области, точки всегда чёткие и одного экранного размера.
 */

let canvasEl: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
/** Слой с видео: его нетрансформированный прямоугольник задаёт систему координат. */
let mediaEl: HTMLElement | null = null;
let dpr = 1;

/**
 * Есть ли под слоем кадр.
 *
 * Точка — это место на изображении, и без него она бессмысленна: до правки
 * сохранённая разметка проступала поверх пустого вьюпорта, стоило выбрать
 * заполненную камеру в списке.
 */
let hasFrame = false;

export function setProjHasFrame(value: boolean): void {
    if (hasFrame === value) return;
    hasFrame = value;
    projDraw();
}

export function projHasFrame(): boolean {
    return hasFrame;
}

export function attachProjCanvas(canvas: HTMLCanvasElement, media: HTMLElement): () => void {
    canvasEl = canvas;
    mediaEl = media;
    ctx = canvas.getContext('2d');
    dpr = window.devicePixelRatio || 1;

    const resize = () => {
        if (!canvasEl) return;
        const parent = canvasEl.parentElement;
        if (!parent) return;
        canvasEl.width = Math.round(parent.offsetWidth * dpr);
        canvasEl.height = Math.round(parent.offsetHeight * dpr);
        projDraw();
    };

    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    resize();

    return () => {
        observer.disconnect();
        canvasEl = null;
        ctx = null;
        mediaEl = null;
    };
}

/**
 * Нетрансформированный прямоугольник видео внутри обёртки.
 * offsetLeft/Width не учитывают CSS-трансформ — именно это и нужно.
 */
function baseRect(): { left: number; top: number; w: number; h: number } | null {
    if (!mediaEl) return null;
    return {
        left: mediaEl.offsetLeft,
        top: mediaEl.offsetTop,
        w: mediaEl.offsetWidth,
        h: mediaEl.offsetHeight,
    };
}

/** Нормализованная точка → координаты внутри обёртки, с учётом зума. */
export function normToWrapper(nx: number, ny: number): { x: number; y: number } | null {
    const base = baseRect();
    if (!base) return null;
    const v = projState.view;
    return {
        x: base.left + v.ox + nx * base.w * v.scale,
        y: base.top + v.oy + ny * base.h * v.scale,
    };
}

/** Координаты указателя → нормализованная точка кадра. */
export function eventToNorm(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const base = baseRect();
    if (!base || !canvasEl) return null;

    const rect = canvasEl.getBoundingClientRect();
    const ex = e.clientX - rect.left;
    const ey = e.clientY - rect.top;
    const v = projState.view;

    return {
        x: Math.min(1, Math.max(0, (ex - base.left - v.ox) / (base.w * v.scale))),
        y: Math.min(1, Math.max(0, (ey - base.top - v.oy) / (base.h * v.scale))),
    };
}

/** Индекс точки под курсором или -1. Радиус попадания в экранных пикселях. */
export function hitPoint(e: { clientX: number; clientY: number }): number {
    if (!canvasEl) return -1;
    const rect = canvasEl.getBoundingClientRect();
    const ex = e.clientX - rect.left;
    const ey = e.clientY - rect.top;

    const HIT_PX = 10;

    for (let i = projState.points.length - 1; i >= 0; i--) {
        const p = normToWrapper(projState.points[i].x, projState.points[i].y);
        if (!p) continue;
        if (Math.hypot(ex - p.x, ey - p.y) < HIT_PX) return i;
    }
    return -1;
}

export function projDraw(): void {
    if (!ctx || !canvasEl) return;

    const c = ctx;
    c.clearRect(0, 0, canvasEl.width, canvasEl.height);

    if (!hasFrame) return;

    const pts = projState.points;
    if (!pts.length) return;

    const PX = dpr;
    const R = 7 * PX;
    const RING = 3 * PX;
    const LINE_W = 1.5 * PX;
    const FONT = 11 * PX;

    const screen = pts.map(p => {
        const w = normToWrapper(p.x, p.y);
        return w ? { x: w.x * dpr, y: w.y * dpr } : null;
    });

    // Ломаная без замыкания первой и последней точки
    if (pts.length > 1) {
        c.beginPath();
        c.strokeStyle = CANVAS_COLORS.accentLine;
        c.lineWidth = LINE_W;
        c.setLineDash([6 * PX, 3 * PX]);
        let started = false;
        screen.forEach(p => {
            if (!p) return;
            if (!started) {
                c.moveTo(p.x, p.y);
                started = true;
            } else {
                c.lineTo(p.x, p.y);
            }
        });
        c.stroke();
        c.setLineDash([]);
    }

    screen.forEach((p, i) => {
        if (!p) return;

        c.beginPath();
        c.arc(p.x, p.y, R + RING, 0, Math.PI * 2);
        c.fillStyle = CANVAS_COLORS.shadow;
        c.fill();

        c.beginPath();
        c.arc(p.x, p.y, R, 0, Math.PI * 2);
        c.fillStyle = CANVAS_COLORS.accent;
        c.strokeStyle = CANVAS_COLORS.base;
        c.lineWidth = LINE_W;
        c.fill();
        c.stroke();

        const label = String(i + 1);
        c.font = `bold ${FONT}px monospace`;
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        const tw = c.measureText(label).width;
        const lx = p.x + R + 6 * PX;
        const pad = 3 * PX;

        c.fillStyle = CANVAS_COLORS.labelBackdrop;
        c.beginPath();
        c.roundRect(lx - pad, p.y - 8 * PX, tw + pad * 2, 16 * PX, 3 * PX);
        c.fill();

        c.fillStyle = CANVAS_COLORS.accent;
        c.fillText(label, lx, p.y);
    });
}

/**
 * Держит слой видео в пределах обёртки, как _clampPan в оригинале.
 *
 * После трансформа слой занимает [base.left + ox, base.left + ox + base.w*s].
 * Пока он меньше обёртки — центрируем; когда больше — не даём отвести край
 * внутрь, иначе появится пустая полоса.
 */
export function clampPan(): void {
    const base = baseRect();
    if (!base || !canvasEl) return;
    const parent = canvasEl.parentElement;
    if (!parent) return;

    const v = projState.view;

    v.ox = clampAxis(v.ox, base.left, base.w * v.scale, parent.offsetWidth);
    v.oy = clampAxis(v.oy, base.top, base.h * v.scale, parent.offsetHeight);
}

function clampAxis(offset: number, baseStart: number, scaled: number, available: number): number {
    if (scaled <= available) return (available - scaled) / 2 - baseStart;
    const min = available - scaled - baseStart;
    const max = -baseStart;
    return Math.min(max, Math.max(min, offset));
}

/** CSS-трансформ слоя видео. Канвас его не получает — он рисует сам. */
export function mediaTransform(): string {
    const v = projState.view;
    return `translate(${v.ox}px, ${v.oy}px) scale(${v.scale})`;
}
