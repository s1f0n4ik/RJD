import { projState } from '../../state/proj-store';
import { CANVAS_COLORS } from '../../styles/canvas-colors';

/**
 * Слой точек warp. Порт canvas.js из no-react.
 *
 * Канвас лежит внутри трансформируемого слоя видео и позиционируется ровно
 * на content-box кадра: letterbox считается из videoWidth/videoHeight, как
 * в оригинальном resizeCanvas. Зум и пан канвас наследует от слоя, поэтому
 * нормализация точки — это просто позиция внутри собственного прямоугольника
 * канваса, без ручного учёта трансформа.
 *
 * Bitmap растёт вместе с зумом ради чёткости, как в оригинале, но ограничен
 * MAX_BITMAP: на MAX_SCALE = 12 и dpr = 2 оригинал создавал 30720×23040 —
 * за пределом Chrome, и канвас молча переставал рисовать.
 */

let canvasEl: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
/** Слой с видео: канвас позиционируется внутри него. */
let mediaEl: HTMLElement | null = null;
let dpr = 1;

// Реальное разрешение кадра, задаёт letterbox канваса внутри слоя
let videoW = 0;
let videoH = 0;

// Content-box кадра в CSS-пикселях слоя
let baseW = 0;
let baseH = 0;

// Scale, под который создан текущий bitmap
let lastScale = 0;

const MAX_BITMAP = 8192;

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

/** Реальное разрешение кадра из метаданных видео. */
export function setProjVideoSize(width: number, height: number): void {
    if (videoW === width && videoH === height) return;
    videoW = width;
    videoH = height;
    layoutCanvas();
}

export function attachProjCanvas(canvas: HTMLCanvasElement, media: HTMLElement): () => void {
    canvasEl = canvas;
    mediaEl = media;
    ctx = canvas.getContext('2d');
    dpr = window.devicePixelRatio || 1;

    const observer = new ResizeObserver(() => layoutCanvas());
    observer.observe(media);
    layoutCanvas();

    return () => {
        observer.disconnect();
        canvasEl = null;
        ctx = null;
        mediaEl = null;
    };
}

// Канвас накрывает ровно кадр: letterbox внутри слоя по соотношению видео
function layoutCanvas(): void {
    if (!canvasEl || !mediaEl) return;
    const lw = mediaEl.offsetWidth;
    const lh = mediaEl.offsetHeight;
    if (lw <= 0 || lh <= 0) return;

    let w = lw;
    let h = lh;
    if (videoW > 0 && videoH > 0) {
        const layerRatio = lw / lh;
        const videoRatio = videoW / videoH;
        if (videoRatio > layerRatio) {
            w = lw;
            h = Math.round(lw / videoRatio);
        } else {
            h = lh;
            w = Math.round(lh * videoRatio);
        }
    }

    baseW = w;
    baseH = h;
    canvasEl.style.width = `${w}px`;
    canvasEl.style.height = `${h}px`;
    canvasEl.style.left = `${Math.round((lw - w) / 2)}px`;
    canvasEl.style.top = `${Math.round((lh - h) / 2)}px`;

    resizeBitmap();
}

function resizeBitmap(): void {
    if (!canvasEl || baseW <= 0 || baseH <= 0) return;
    const s = projState.view.scale || 1;
    const k = Math.min(s * dpr, MAX_BITMAP / Math.max(baseW, baseH));
    canvasEl.width = Math.round(baseW * k);
    canvasEl.height = Math.round(baseH * k);
    lastScale = s;
    projDraw();
}

/** Вызывается после смены transform слоя: bitmap пересоздаётся только на смене зума. */
export function projSyncZoom(): void {
    if (projState.view.scale !== lastScale) resizeBitmap();
    else projDraw();
}

/** Координаты указателя → нормализованная точка кадра. */
export function eventToNorm(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    if (!canvasEl) return null;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
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
        const p = projState.points[i];
        const px = p.x * rect.width;
        const py = p.y * rect.height;
        if (Math.hypot(ex - px, ey - py) < HIT_PX) return i;
    }
    return -1;
}

export function projDraw(): void {
    if (!ctx || !canvasEl) return;

    const c = ctx;
    const W = canvasEl.width;
    const H = canvasEl.height;
    c.clearRect(0, 0, W, H);

    if (!hasFrame || baseW <= 0) return;

    const pts = projState.points;
    if (!pts.length) return;

    // Точки фиксированного экранного размера при любом зуме
    const s = projState.view.scale || 1;
    const PX = W / (baseW * s);

    const R = 7 * PX;
    const RING = 3 * PX;
    const LINE_W = 1.5 * PX;
    const FONT = 11 * PX;

    const screen = pts.map(p => ({ x: p.x * W, y: p.y * H }));

    // Ломаная без замыкания первой и последней точки
    if (pts.length > 1) {
        c.beginPath();
        c.strokeStyle = CANVAS_COLORS.accentLine;
        c.lineWidth = LINE_W;
        c.setLineDash([6 * PX, 3 * PX]);
        screen.forEach((p, i) => {
            if (i === 0) {
                c.moveTo(p.x, p.y);
            } else {
                c.lineTo(p.x, p.y);
            }
        });
        c.stroke();
        c.setLineDash([]);
    }

    screen.forEach((p, i) => {
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
    if (!mediaEl) return;
    const parent = mediaEl.parentElement;
    if (!parent) return;

    const v = projState.view;

    v.ox = clampAxis(v.ox, mediaEl.offsetLeft, mediaEl.offsetWidth * v.scale, parent.offsetWidth);
    v.oy = clampAxis(v.oy, mediaEl.offsetTop, mediaEl.offsetHeight * v.scale, parent.offsetHeight);
}

function clampAxis(offset: number, baseStart: number, scaled: number, available: number): number {
    if (scaled <= available) return (available - scaled) / 2 - baseStart;
    const min = available - scaled - baseStart;
    const max = -baseStart;
    return Math.min(max, Math.max(min, offset));
}

/** CSS-трансформ слоя видео. Канвас лежит внутри слоя и наследует его. */
export function mediaTransform(): string {
    const v = projState.view;
    return `translate(${v.ox}px, ${v.oy}px) scale(${v.scale})`;
}
