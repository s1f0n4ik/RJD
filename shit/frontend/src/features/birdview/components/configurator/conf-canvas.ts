import { CAMERA_FRACTION, confState, fmtM, HANDLE_SIZE, q } from '../../state/conf-store';
import type { ConfCamera, ConfZone } from '../../types';
import { CANVAS_COLORS } from '../../styles/canvas-colors';

// Отрисовка холста конфигуратора. Рисование по требованию: confDraw после каждой
// мутации confState, RAF-цикла нет, React в отрисовке не участвует.
// Мировые координаты — метры, view.scale — экранных пикселей на метр.

// Габарит рисуется своим цветом, а не акцентным: он не часть выделения
const GABARIT_COLOR = '#E8A33D';
const GABARIT_FILL = 'rgba(232,163,61,0.08)';
const GABARIT_GUIDE = 'rgba(232,163,61,0.35)';

// Оси размерных линий разведены цветом. Линия, засечки, подпись и продолжение
// грани — всё в цвете своей оси
const AXIS_COLOR = { x: CANVAS_COLORS.accent, y: GABARIT_COLOR } as const;
const AXIS_GUIDE = { x: CANVAS_COLORS.accentGuide, y: GABARIT_GUIDE } as const;

let canvasEl: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let dpr = 1;
let fitted = false;

/** Привязывает модуль к холсту. Возвращает функцию отвязки. */
export function attachConfCanvas(el: HTMLCanvasElement): () => void {
    canvasEl = el;
    ctx = el.getContext('2d');
    dpr = window.devicePixelRatio || 1;
    fitted = false;

    const area = el.parentElement;
    const observer = new ResizeObserver(resize);
    if (area) observer.observe(area);
    resize();

    return () => {
        observer.disconnect();
        canvasEl = null;
        ctx = null;
    };
}

function resize(): void {
    if (!canvasEl) return;
    const area = canvasEl.parentElement;
    if (!area) return;
    canvasEl.width = Math.round(area.offsetWidth * dpr);
    canvasEl.height = Math.round(area.offsetHeight * dpr);

    // Первый замер с ненулевым размером — вписываем поле в холст. Экран может
    // быть смонтирован скрытым, тогда до показа размеры нулевые.
    if (!fitted && area.offsetWidth > 0 && area.offsetHeight > 0) {
        fitFieldToView();
        fitted = true;
    }

    confDraw();
}

/** Вписывает поле в холст по центру. */
export function fitFieldToView(): void {
    if (!canvasEl) return;
    const area = canvasEl.parentElement;
    if (!area || !area.offsetWidth || !area.offsetHeight) return;

    const f = confState.field;
    const scale = Math.min(area.offsetWidth / f.w, area.offsetHeight / f.h) * 0.9;

    confState.view.scale = scale;
    confState.view.ox = (area.offsetWidth - f.w * scale) / 2;
    confState.view.oy = (area.offsetHeight - f.h * scale) / 2;
}

export function worldToCanvas(wx: number, wy: number): { x: number; y: number } {
    const v = confState.view;
    return {
        x: (wx * v.scale + v.ox) * dpr,
        y: (wy * v.scale + v.oy) * dpr,
    };
}

export function canvasToWorld(cx: number, cy: number): { x: number; y: number } {
    const v = confState.view;
    const rect = canvasEl?.getBoundingClientRect();
    return {
        x: (cx - (rect?.left ?? 0) - v.ox) / v.scale,
        y: (cy - (rect?.top ?? 0) - v.oy) / v.scale,
    };
}

export function snap(val: number): number {
    const s = confState.field.step;
    return q(Math.round(val / s) * s);
}

export function clampToField(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const f = confState.field;
    return {
        x: q(Math.max(0, Math.min(f.w - w, x))),
        y: q(Math.max(0, Math.min(f.h - h, y))),
    };
}

// Мат — физический квадрат, померянный рулеткой, и ужимать его нельзя.
// Вместо этого вызывающий обязан проверить, помещается ли он в поле.
export function zoneFitsField(size: number): boolean {
    const f = confState.field;
    return size <= f.w + 1e-9 && size <= f.h + 1e-9;
}

/** Грани и центр мата. Мат всегда осевой. */
function zoneSpan(zone: ConfZone): { l: number; r: number; t: number; b: number; cx: number; cy: number } {
    return {
        l: zone.x,
        r: zone.x + zone.w,
        t: zone.y,
        b: zone.y + zone.h,
        cx: zone.x + zone.w / 2,
        cy: zone.y + zone.h / 2,
    };
}

export interface ZoneGaps {
    x: number;
    y: number;
}

interface AxisGap {
    value: number;
    /** Грань мата, от которой мерялось. */
    matEdge: number;
    /** Грань габарита, до которой мерялось. */
    gabEdge: number;
}

// Зазор вдоль одной оси по ближайшей паре граней. Знак задаётся отдельно от
// величины: минус означает, что проекции налезают друг на друга.
// Перебираются все четыре пары, а не только встречные: когда мат внутри
// проекции габарита, встречные грани дают расстояние до дальнего края.
function axisGap(matLo: number, matHi: number, gabLo: number, gabHi: number): AxisGap {
    const pairs = [
        { matEdge: matHi, gabEdge: gabLo },
        { matEdge: matLo, gabEdge: gabHi },
        { matEdge: matLo, gabEdge: gabLo },
        { matEdge: matHi, gabEdge: gabHi },
    ];

    let best = pairs[0];
    let dist = Math.abs(best.gabEdge - best.matEdge);
    for (const p of pairs) {
        const d = Math.abs(p.gabEdge - p.matEdge);
        if (d < dist) {
            dist = d;
            best = p;
        }
    }

    const overlap = matLo < gabHi && gabLo < matHi;
    return { value: overlap ? -dist : dist, matEdge: best.matEdge, gabEdge: best.gabEdge };
}

interface MeasureTarget {
    l: number;
    r: number;
    t: number;
    b: number;
    /** Мат-ориентир, если замер переведён на него по Alt. */
    ref: ConfZone | null;
}

/** Прямоугольник, до которого мерятся расстояния: мат-ориентир или габарит. */
function measureTarget(zone: ConfZone): MeasureTarget | null {
    const link = confState.measureRef;
    if (link && link.fromId === zone.id) {
        const ref = confState.zones.find(z => z.id === link.toId);
        if (ref) {
            const s = zoneSpan(ref);
            return { l: s.l, r: s.r, t: s.t, b: s.b, ref };
        }
    }

    const gab = confState.gabarits[0];
    if (!gab) return null;
    return { l: gab.x, r: gab.x + gab.w, t: gab.y, b: gab.y + gab.h, ref: null };
}

/**
 * Зазоры между матом и целью замера по осям. null — мерять не к чему.
 */
// Габарит без поворота, маты — по реальному следу повёрнутого квадрата
export function zoneGaps(zone: ConfZone): ZoneGaps | null {
    const target = measureTarget(zone);
    if (!target) return null;

    const m = zoneSpan(zone);
    return {
        x: q(axisGap(m.l, m.r, target.l, target.r).value),
        y: q(axisGap(m.t, m.b, target.t, target.b).value),
    };
}

/** Камера захватывает мат: след повёрнутого квадрата целиком в её прямоугольнике. */
export function zoneCaptured(cam: ConfCamera, zone: ConfZone): boolean {
    const s = zoneSpan(zone);
    return s.l >= cam.x - 1e-9 && s.r <= cam.x + cam.w + 1e-9
        && s.t >= cam.y - 1e-9 && s.b <= cam.y + cam.h + 1e-9;
}

/** Камеры, захватившие мат, в порядке списка камер. */
export function zoneCameras(zone: ConfZone): ConfCamera[] {
    return confState.cameras.filter(cam => zoneCaptured(cam, zone));
}

/**
 * «Поворот» мата для камеры: 0 — стрелка вниз, 90 — влево, 180 — вверх,
 * 270 — вправо. Стрелка противоположна взгляду значка камеры.
 *
 * Взгляд квантуется в 8 секторов по 45°. Осевой сектор даёт всем матам камеры
 * одно направление. В диагональном маты делятся линией, проведённой через
 * значок вдоль диагонали: каждая половина ведёт себя как соседний осевой
 * сектор. Мат ровно на линии уходит к вертикальной из двух осей.
 */
export function zoneRotationFor(cam: ConfCamera, zone: ConfZone): number {
    const icon = cameraIconPos(cam);
    if (!icon) return 0;

    // Оси секторов: 0 — вправо, 2 — вниз, 4 — влево, 6 — вверх
    const viewDeg = ((icon.angle * 180) / Math.PI + 360) % 360;
    const sector = Math.round(viewDeg / 45) % 8;

    let axis: number;
    if (sector % 2 === 0) {
        axis = sector;
    } else {
        const rad = (sector * Math.PI) / 4;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        const ox = zone.x + zone.w / 2 - icon.x;
        const oy = zone.y + zone.h / 2 - icon.y;
        const cross = dx * oy - dy * ox;

        const lo = (sector + 7) % 8;
        const hi = (sector + 1) % 8;
        if (cross < 0) axis = lo;
        else if (cross > 0) axis = hi;
        else axis = lo === 2 || lo === 6 ? lo : hi;
    }

    // Стрелка противоположна оси взгляда: взгляд вверх (270°) → поворот 0
    return (axis * 45 + 90) % 360;
}

/** Загоняет мат внутрь поля. Размер не меняет. */
export function clampZoneToField(zone: ConfZone): void {
    const f = confState.field;

    // Не помещается — центрируем; сюда попадает только импорт чужой геометрии
    const cx = zone.w > f.w
        ? f.w / 2
        : Math.max(zone.w / 2, Math.min(f.w - zone.w / 2, zone.x + zone.w / 2));
    const cy = zone.h > f.h
        ? f.h / 2
        : Math.max(zone.h / 2, Math.min(f.h - zone.h / 2, zone.y + zone.h / 2));

    zone.x = q(cx - zone.w / 2);
    zone.y = q(cy - zone.h / 2);
}

export function confDraw(): void {
    if (!ctx || !canvasEl) return;
    const W = canvasEl.width;
    const H = canvasEl.height;
    ctx.clearRect(0, 0, W, H);

    drawGrid(ctx);
    drawImages(ctx);
    drawGabarit(ctx);
    drawCameras(ctx);
    drawZones(ctx);
    drawCameraArrows(ctx);
    drawSelection(ctx);
    // Значки видны всегда, поэтому поверх выделения
    drawCameraIcons(ctx);
    drawDraft(ctx);
    drawPlacePreview(ctx);
    drawCrosshair(ctx);
}

/** Создаваемый объект под указателем: точка — его центр, как и при броске. */
function drawPlacePreview(c: CanvasRenderingContext2D): void {
    const p = confState.placing;
    if (!p) return;

    const f = confState.field;
    // Габарит один: превью повторяет его размер, а не создаёт новый
    const gab = confState.gabarits[0];
    let sw = q(f.w * CAMERA_FRACTION);
    let sh = q(f.h * CAMERA_FRACTION);
    if (p.kind === 'zone') {
        sw = confState.matSize;
        sh = confState.matSize;
    } else if (p.kind === 'gabarit') {
        sw = gab ? gab.w : snap(f.w * 0.25);
        sh = gab ? gab.h : snap(f.h * 0.5);
    }

    // Подпись показывает угол, а не курсор: его же покажет готовый объект
    const cornerX = q(p.x - sw / 2);
    const cornerY = q(p.y - sh / 2);

    const tl = worldToCanvas(cornerX, cornerY);
    const br = worldToCanvas(cornerX + sw, cornerY + sh);
    const w = br.x - tl.x;
    const h = br.y - tl.y;

    c.fillStyle = p.kind === 'gabarit' ? GABARIT_FILL : CANVAS_COLORS.accentFill;
    c.strokeStyle = p.kind === 'gabarit' ? GABARIT_COLOR : CANVAS_COLORS.accent;
    c.lineWidth = 1.5 * dpr;
    c.setLineDash([4 * dpr, 3 * dpr]);
    c.fillRect(tl.x, tl.y, w, h);
    c.strokeRect(tl.x, tl.y, w, h);
    c.setLineDash([]);

    c.fillStyle = p.kind === 'gabarit' ? GABARIT_COLOR : CANVAS_COLORS.accent;
    c.font = `${10 * dpr}px monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillText(`${fmtM(cornerX)} ${fmtM(cornerY)}`, tl.x + w / 2, tl.y - 4 * dpr);
}

/** Прямоугольник машины: под камерами, чтобы не мешал разметке. */
function drawGabarit(c: CanvasRenderingContext2D): void {
    const color = GABARIT_COLOR;
    confState.gabarits.forEach(g => {
        const tl = worldToCanvas(g.x, g.y);
        const br = worldToCanvas(g.x + g.w, g.y + g.h);
        const w = br.x - tl.x;
        const h = br.y - tl.y;

        c.fillStyle = GABARIT_FILL;
        c.strokeStyle = color;
        c.lineWidth = 2 * dpr;
        c.setLineDash([8 * dpr, 5 * dpr]);
        c.fillRect(tl.x, tl.y, w, h);
        c.strokeRect(tl.x, tl.y, w, h);
        c.setLineDash([]);

        // Диагонали, чтобы не путать с камерой
        c.strokeStyle = GABARIT_GUIDE;
        c.lineWidth = 1 * dpr;
        c.beginPath();
        c.moveTo(tl.x, tl.y);
        c.lineTo(br.x, br.y);
        c.moveTo(br.x, tl.y);
        c.lineTo(tl.x, br.y);
        c.stroke();

        // Ширина машины вдоль X, длина вдоль Y
        c.fillStyle = color;
        c.font = `bold ${11 * dpr}px monospace`;
        c.textAlign = 'left';
        c.textBaseline = 'top';
        c.fillText(`Габарит ${fmtM(g.w)}×${fmtM(g.h)} м`, tl.x + 4 * dpr, tl.y + 4 * dpr);
    });
}

/** Рамка области, которую пользователь сейчас растягивает инструментом. */
function drawDraft(c: CanvasRenderingContext2D): void {
    const d = confState.draft;
    if (!d) return;

    const tl = worldToCanvas(d.x, d.y);
    const br = worldToCanvas(d.x + d.w, d.y + d.h);
    const w = br.x - tl.x;
    const h = br.y - tl.y;

    c.fillStyle = CANVAS_COLORS.accentFill;
    c.strokeStyle = CANVAS_COLORS.accent;
    c.lineWidth = 1.5 * dpr;
    c.setLineDash([5 * dpr, 4 * dpr]);
    c.fillRect(tl.x, tl.y, w, h);
    c.strokeRect(tl.x, tl.y, w, h);
    c.setLineDash([]);

    c.fillStyle = CANVAS_COLORS.accent;
    c.font = `${10 * dpr}px monospace`;
    c.textAlign = 'left';
    c.textBaseline = 'bottom';
    c.fillText(`${fmtM(d.w)}×${fmtM(d.h)} м`, tl.x, tl.y - 4 * dpr);
}

function drawGrid(c: CanvasRenderingContext2D): void {
    const f = confState.field;
    const s = confState.field.step;
    const v = confState.view;

    const tl = worldToCanvas(0, 0);
    const br = worldToCanvas(f.w, f.h);
    const fw = br.x - tl.x;
    const fh = br.y - tl.y;

    // Фон поля
    c.fillStyle = CANVAS_COLORS.panelBackdrop;
    c.fillRect(tl.x, tl.y, fw, fh);

    // Сетка
    const stepPx = s * v.scale * dpr;
    if (stepPx > 6) {
        c.strokeStyle = 'rgba(37,37,48,0.6)';
        c.lineWidth = 1;
        c.beginPath();
        for (let wx = s; wx < f.w; wx += s) {
            const { x } = worldToCanvas(wx, 0);
            c.moveTo(x, tl.y);
            c.lineTo(x, br.y);
        }
        for (let wy = s; wy < f.h; wy += s) {
            const { y } = worldToCanvas(0, wy);
            c.moveTo(tl.x, y);
            c.lineTo(br.x, y);
        }
        c.stroke();
    }

    // Рамка поля
    c.strokeStyle = CANVAS_COLORS.accentGuide;
    c.lineWidth = 2 * dpr;
    c.strokeRect(tl.x, tl.y, fw, fh);
}

function drawCameras(c: CanvasRenderingContext2D): void {
    confState.cameras.forEach(cam => {
        const tl = worldToCanvas(cam.x, cam.y);
        const br = worldToCanvas(cam.x + cam.w, cam.y + cam.h);
        const w = br.x - tl.x;
        const h = br.y - tl.y;

        c.fillStyle = hex2rgba(cam.color, 0.12);
        c.strokeStyle = cam.color;
        c.lineWidth = 1.5 * dpr;
        c.fillRect(tl.x, tl.y, w, h);
        c.strokeRect(tl.x, tl.y, w, h);

        c.fillStyle = cam.color;
        c.font = `bold ${11 * dpr}px monospace`;
        c.textAlign = 'left';
        c.textBaseline = 'top';
        c.fillText(cam.name, tl.x + 4 * dpr, tl.y + 4 * dpr);
    });
}

// Стрелок в дефолте нет: направление — свойство пары камера-мат, его рисует
// drawCameraArrows при выделенной камере
function drawZones(c: CanvasRenderingContext2D): void {
    // Номер глобальный: позиция в списке, она же порядок записи в экспорт
    confState.zones.forEach((zone, index) => {
        const tl = worldToCanvas(zone.x, zone.y);
        const br = worldToCanvas(zone.x + zone.w, zone.y + zone.h);
        const w = br.x - tl.x;
        const h = br.y - tl.y;

        // Заливка + рамка
        c.fillStyle = hex2rgba(zone.color, 0.15);
        c.strokeStyle = zone.color;
        c.lineWidth = 1 * dpr;
        c.setLineDash([4 * dpr, 3 * dpr]);
        c.fillRect(tl.x, tl.y, w, h);
        c.strokeRect(tl.x, tl.y, w, h);
        c.setLineDash([]);

        // Глобальный номер зоны — крупный, по центру
        const numSize = Math.min(w, h) * 0.3;
        const fontSize = Math.max(12 * dpr, Math.min(numSize, 28 * dpr));
        c.fillStyle = zone.color;
        c.font = `bold ${fontSize}px monospace`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.globalAlpha = 0.6;
        c.fillText(String(index + 1), tl.x + w / 2, tl.y + h / 2);
        c.globalAlpha = 1;

        // Имя — левый верхний угол
        c.fillStyle = zone.color;
        c.font = `${10 * dpr}px monospace`;
        c.textAlign = 'left';
        c.textBaseline = 'top';
        c.fillText(zone.name, tl.x + 3 * dpr, tl.y + 3 * dpr);
    });
}

// Направления матов выделенной камеры: стрелка и метка якорного угла (первая
// точка четвёрки dst_points) в цвете камеры
function drawCameraArrows(c: CanvasRenderingContext2D): void {
    const sel = confState.selected;
    if (!sel || sel.type !== 'camera') return;
    const cam = confState.cameras.find(i => i.id === sel.id);
    if (!cam) return;

    confState.zones.forEach(zone => {
        if (!zoneCaptured(cam, zone)) return;

        const tl = worldToCanvas(zone.x, zone.y);
        const br = worldToCanvas(zone.x + zone.w, zone.y + zone.h);
        const w = br.x - tl.x;
        const h = br.y - tl.y;
        const rad = (zoneRotationFor(cam, zone) * Math.PI) / 180;

        c.save();
        c.translate(tl.x + w / 2, tl.y + h / 2);
        c.rotate(rad);

        // Стрелка «вниз» в локальных осях — поворот задаёт направление
        const arrowLen = Math.min(w, h) * 0.25;
        const arrowY = h * 0.15;
        c.strokeStyle = cam.color;
        c.lineWidth = 2.5 * dpr;
        c.beginPath();
        c.moveTo(0, arrowY - arrowLen * 0.4);
        c.lineTo(0, arrowY + arrowLen * 0.4);
        c.stroke();

        // Наконечник
        c.beginPath();
        c.moveTo(-arrowLen * 0.22, arrowY + arrowLen * 0.1);
        c.lineTo(0, arrowY + arrowLen * 0.4);
        c.lineTo(arrowLen * 0.22, arrowY + arrowLen * 0.1);
        c.stroke();

        // Якорный угол bl — слева от стрелки
        c.beginPath();
        c.arc(-w / 2, h / 2, 3.5 * dpr, 0, Math.PI * 2);
        c.fillStyle = cam.color;
        c.fill();

        c.restore();
    });
}

function drawImages(c: CanvasRenderingContext2D): void {
    confState.images.forEach(img => {
        if (!img.img) return;
        const tl = worldToCanvas(img.x, img.y);
        const br = worldToCanvas(img.x + img.w, img.y + img.h);
        c.drawImage(img.img, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    });
}

function drawSelection(c: CanvasRenderingContext2D): void {
    const sel = confState.selected;
    if (!sel) return;

    let item;
    if (sel.type === 'camera') item = confState.cameras.find(i => i.id === sel.id);
    if (sel.type === 'zone') item = confState.zones.find(i => i.id === sel.id);
    if (sel.type === 'image') item = confState.images.find(i => i.id === sel.id);
    if (sel.type === 'gabarit') item = confState.gabarits.find(i => i.id === sel.id);
    if (!item) return;

    const tl = worldToCanvas(item.x, item.y);
    const br = worldToCanvas(item.x + item.w, item.y + item.h);
    const w = br.x - tl.x;
    const h = br.y - tl.y;

    const hs = HANDLE_SIZE * dpr;

    // Рамка. Ручек у разметки нет вовсе: сторона квадрата общая и меняется
    // полем «Сторона мата» в панели, поворот считается на лету по камере
    c.strokeStyle = CANVAS_COLORS.accent;
    c.lineWidth = 2 * dpr;
    c.setLineDash([6 * dpr, 3 * dpr]);
    c.strokeRect(tl.x, tl.y, w, h);
    c.setLineDash([]);

    if (sel.type !== 'zone') {
        const handles: Array<[number, number]> = [
            [tl.x, tl.y],
            [tl.x + w / 2, tl.y],
            [br.x, tl.y],
            [tl.x, tl.y + h / 2],
            [br.x, tl.y + h / 2],
            [tl.x, br.y],
            [tl.x + w / 2, br.y],
            [br.x, br.y],
        ];
        c.fillStyle = CANVAS_COLORS.accent;
        for (const [px, py] of handles) {
            c.fillRect(px - hs, py - hs, hs * 2, hs * 2);
        }
    }

    if (sel.type === 'zone') drawZoneGaps(c, item as ConfZone);
    if (sel.type === 'gabarit') drawGabaritGaps(c, item);

    // Угол над верхней гранью
    c.fillStyle = CANVAS_COLORS.accent;
    c.font = `${10 * dpr}px monospace`;
    c.textAlign = 'left';
    c.textBaseline = 'bottom';
    c.fillText(`X: ${fmtM(item.x)} Y: ${fmtM(item.y)}`, tl.x, tl.y - 6 * dpr);
}

// Размерные линии от граней мата до граней цели замера.
function drawZoneGaps(c: CanvasRenderingContext2D, zone: ConfZone): void {
    const target = measureTarget(zone);
    if (!target) return;

    const m = zoneSpan(zone);
    const gx = axisGap(m.l, m.r, target.l, target.r);
    const gy = axisGap(m.t, m.b, target.t, target.b);

    // Обводка ориентира: иначе непонятно, до какого мата идёт замер
    if (target.ref) drawMeasureRef(c, target.ref);

    c.lineWidth = 1 * dpr;
    c.font = `${10 * dpr}px monospace`;

    // Размер по X идёт на высоте центра мата, по Y — через его центр. Если эта
    // линия проходит мимо цели, её грань продлевается навстречу, иначе размер
    // упирался бы в пустоту
    c.strokeStyle = AXIS_GUIDE.x;
    drawTargetExtension(c, gx.gabEdge, m.cy, target.t, target.b, 'x');
    c.strokeStyle = AXIS_GUIDE.y;
    drawTargetExtension(c, gy.gabEdge, m.cx, target.l, target.r, 'y');

    c.strokeStyle = AXIS_COLOR.x;
    drawGapLine(c, gx.matEdge, m.cy, gx.gabEdge, m.cy, 'x');

    c.strokeStyle = AXIS_COLOR.y;
    drawGapLine(c, m.cx, gy.matEdge, m.cx, gy.gabEdge, 'y');

    // Подпись всегда стоит по середине своей размерной линии
    const lx = gapLabel('x', q(gx.value), AXIS_COLOR.x, (gx.matEdge + gx.gabEdge) / 2, m.cy);
    const ly = gapLabel('y', q(gy.value), AXIS_COLOR.y, m.cx, (gy.matEdge + gy.gabEdge) / 2);

    // По диагонали обе подписи сходятся к углу и налезают
    separateLabels(c, lx, ly);
    drawLabel(c, lx);
    drawLabel(c, ly);
}

// Размеры от габарита до всех четырёх границ поля
function drawGabaritGaps(
    c: CanvasRenderingContext2D,
    g: { x: number; y: number; w: number; h: number },
): void {
    const f = confState.field;
    const cx = g.x + g.w / 2;
    const cy = g.y + g.h / 2;

    c.lineWidth = 1 * dpr;
    c.font = `${10 * dpr}px monospace`;
    c.strokeStyle = GABARIT_COLOR;

    drawGapLine(c, g.x, cy, 0, cy, 'x');
    drawGapLine(c, g.x + g.w, cy, f.w, cy, 'x');
    drawGapLine(c, cx, g.y, cx, 0, 'y');
    drawGapLine(c, cx, g.y + g.h, cx, f.h, 'y');

    drawLabel(c, gapLabel('x', q(g.x), GABARIT_COLOR, g.x / 2, cy));
    drawLabel(c, gapLabel('x', q(f.w - g.x - g.w), GABARIT_COLOR, (g.x + g.w + f.w) / 2, cy));
    drawLabel(c, gapLabel('y', q(g.y), GABARIT_COLOR, cx, g.y / 2));
    drawLabel(c, gapLabel('y', q(f.h - g.y - g.h), GABARIT_COLOR, cx, (g.y + g.h + f.h) / 2));
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

interface GapLabel {
    text: string;
    x: number;
    y: number;
    align: 'left' | 'center';
    baseline: 'bottom' | 'middle';
    color: string;
}

/** Подпись по середине размерной линии: X — над линией, Y — справа от неё. */
function gapLabel(
    axis: 'x' | 'y',
    value: number,
    color: string,
    wx: number,
    wy: number,
): GapLabel {
    const p = worldToCanvas(wx, wy);
    const text = fmtM(value);

    if (axis === 'x') {
        return { text, color, align: 'center', baseline: 'bottom', x: p.x, y: p.y - 4 * dpr };
    }

    return { text, color, align: 'left', baseline: 'middle', x: p.x + 5 * dpr, y: p.y };
}

function labelBox(c: CanvasRenderingContext2D, l: GapLabel): { x0: number; x1: number; y0: number; y1: number } {
    const w = c.measureText(l.text).width;
    const h = 10 * dpr;
    const x0 = l.align === 'center' ? l.x - w / 2 : l.x;
    const y0 = l.baseline === 'bottom' ? l.y - h : l.y - h / 2;
    return { x0, x1: x0 + w, y0, y1: y0 + h };
}

/** Разводит подписи по вертикали, если их прямоугольники пересеклись. */
function separateLabels(c: CanvasRenderingContext2D, keep: GapLabel, move: GapLabel): void {
    const a = labelBox(c, keep);
    const b = labelBox(c, move);
    if (a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0) return;

    // Уводится вниз: сдвиг вверх упёрся бы в подпись угла над самим матом
    move.y += a.y1 - b.y0 + 2 * dpr;
}

function drawLabel(c: CanvasRenderingContext2D, l: GapLabel): void {
    c.fillStyle = l.color;
    c.textAlign = l.align;
    c.textBaseline = l.baseline;
    c.fillText(l.text, l.x, l.y);
}

/** Сплошная обводка мата, до которого переведён замер. */
function drawMeasureRef(c: CanvasRenderingContext2D, zone: ConfZone): void {
    const tl = worldToCanvas(zone.x, zone.y);
    const br = worldToCanvas(zone.x + zone.w, zone.y + zone.h);

    c.setLineDash([]);
    c.strokeStyle = zone.color;
    c.lineWidth = 2 * dpr;
    c.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

// Экранный размер значка камеры, px: корпус и длина клина-объектива
const CAM_ICON_R = 9;
const CAM_ICON_WEDGE = 22;

interface CamIcon {
    x: number;
    y: number;
    /** Направление взгляда — на центр квадрата камеры, рад. */
    angle: number;
}

/** Точка периметра прямоугольника, ближайшая к произвольной точке. */
function nearestOnPerimeter(px: number, py: number, g: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
    const inX = px > g.x && px < g.x + g.w;
    const inY = py > g.y && py < g.y + g.h;
    if (!inX || !inY) {
        return { x: clamp(px, g.x, g.x + g.w), y: clamp(py, g.y, g.y + g.h) };
    }

    // Точка внутри — проекция на ближайшую из четырёх граней
    const dl = px - g.x;
    const dr = g.x + g.w - px;
    const dt = py - g.y;
    const db = g.y + g.h - py;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: g.x, y: py };
    if (m === dr) return { x: g.x + g.w, y: py };
    if (m === dt) return { x: px, y: g.y };
    return { x: px, y: g.y + g.h };
}

/** Значок камеры — точка монтажа на периметре габарита. null — габарита нет. */
export function cameraIconPos(cam: ConfCamera): CamIcon | null {
    const g = confState.gabarits[0];
    if (!g) return null;

    const cx = cam.x + cam.w / 2;
    const cy = cam.y + cam.h / 2;
    const p = nearestOnPerimeter(cx, cy, g);

    // Центр квадрата лёг ровно на периметр — взгляд наружу от центра габарита
    const dx = cx - p.x;
    const dy = cy - p.y;
    const angle = dx || dy
        ? Math.atan2(dy, dx)
        : Math.atan2(p.y - (g.y + g.h / 2), p.x - (g.x + g.w / 2));

    return { x: p.x, y: p.y, angle };
}

/** Верхняя камера, чей значок накрывает точку. Радиус — экранный, не мировой. */
export function cameraIconAt(wx: number, wy: number): ConfCamera | null {
    for (let i = confState.cameras.length - 1; i >= 0; i--) {
        const cam = confState.cameras[i];
        const icon = cameraIconPos(cam);
        if (!icon) continue;
        const r = (CAM_ICON_R + 4) / confState.view.scale;
        if (Math.hypot(wx - icon.x, wy - icon.y) <= r) return cam;
    }
    return null;
}

function drawCameraIcons(c: CanvasRenderingContext2D): void {
    const g = confState.gabarits[0];
    if (!g) return;

    confState.cameras.forEach(cam => {
        const icon = cameraIconPos(cam);
        if (!icon) return;

        const p = worldToCanvas(icon.x, icon.y);
        const a = icon.angle;
        const wedge = CAM_ICON_WEDGE * dpr;
        const spread = Math.PI / 7;

        // Клин-объектив в сторону центра квадрата камеры
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(p.x + Math.cos(a - spread) * wedge, p.y + Math.sin(a - spread) * wedge);
        c.lineTo(p.x + Math.cos(a + spread) * wedge, p.y + Math.sin(a + spread) * wedge);
        c.closePath();
        c.fillStyle = hex2rgba(cam.color, 0.35);
        c.fill();

        // Корпус: тёмная обводка отделяет значок от заливки габарита
        c.beginPath();
        c.arc(p.x, p.y, CAM_ICON_R * dpr, 0, Math.PI * 2);
        c.fillStyle = cam.color;
        c.strokeStyle = CANVAS_COLORS.base;
        c.lineWidth = 1.5 * dpr;
        c.fill();
        c.stroke();

        // Зрачок
        c.beginPath();
        c.arc(p.x + Math.cos(a) * 3.5 * dpr, p.y + Math.sin(a) * 3.5 * dpr, 2.5 * dpr, 0, Math.PI * 2);
        c.fillStyle = CANVAS_COLORS.base;
        c.fill();

        const isSelected = confState.selected?.type === 'camera' && confState.selected.id === cam.id;
        if (!isSelected) return;

        c.beginPath();
        c.arc(p.x, p.y, (CAM_ICON_R + 3) * dpr, 0, Math.PI * 2);
        c.strokeStyle = CANVAS_COLORS.accent;
        c.lineWidth = 1.5 * dpr;
        c.stroke();

        // Координаты точки монтажа — от левого верхнего угла габарита.
        // Подпись над значком, выше кольца выделения
        c.fillStyle = cam.color;
        c.font = `${10 * dpr}px monospace`;
        c.textAlign = 'center';
        c.textBaseline = 'bottom';
        c.fillText(
            `X: ${fmtM(q(icon.x - g.x))} Y: ${fmtM(q(icon.y - g.y))}`,
            p.x,
            p.y - (CAM_ICON_R + 7) * dpr,
        );
    });
}

// Перекрестие в узле сетки, ближайшем к курсору, через весь холст.
// Значения — у начал линий: X у верхнего края, Y у левого
function drawCrosshair(c: CanvasRenderingContext2D): void {
    if (!confState.showCrosshair || !confState.cursor || !canvasEl) return;

    const f = confState.field;
    const sx = clamp(snap(confState.cursor.x), 0, f.w);
    const sy = clamp(snap(confState.cursor.y), 0, f.h);
    const p = worldToCanvas(sx, sy);

    c.strokeStyle = CANVAS_COLORS.accentGuide;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(p.x, 0);
    c.lineTo(p.x, canvasEl.height);
    c.moveTo(0, p.y);
    c.lineTo(canvasEl.width, p.y);
    c.stroke();

    c.fillStyle = CANVAS_COLORS.accent;
    c.font = `${10 * dpr}px monospace`;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText(fmtM(sx), p.x + 4 * dpr, 4 * dpr);
    c.textBaseline = 'bottom';
    c.fillText(fmtM(sy), 4 * dpr, p.y - 4 * dpr);
}

/**
 * Продолжает грань цели вдоль неё самой до координаты размерной линии.
 *
 * axis 'x' — грань вертикальная, edge это её x, тянем по y; 'y' — наоборот.
 */
function drawTargetExtension(
    c: CanvasRenderingContext2D,
    edge: number,
    reach: number,
    spanLo: number,
    spanHi: number,
    axis: 'x' | 'y',
): void {
    // Линия попадает в саму грань — продлевать нечего
    if (reach >= spanLo && reach <= spanHi) return;

    const from = reach < spanLo ? spanLo : spanHi;
    const a = axis === 'x' ? worldToCanvas(edge, from) : worldToCanvas(from, edge);
    const b = axis === 'x' ? worldToCanvas(edge, reach) : worldToCanvas(reach, edge);

    c.setLineDash([2 * dpr, 4 * dpr]);
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.setLineDash([]);
}

function drawGapLine(
    c: CanvasRenderingContext2D,
    wx1: number,
    wy1: number,
    wx2: number,
    wy2: number,
    axis: 'x' | 'y',
): void {
    const a = worldToCanvas(wx1, wy1);
    const b = worldToCanvas(wx2, wy2);

    c.setLineDash([3 * dpr, 3 * dpr]);
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.setLineDash([]);

    // Засечки на концах: без них линия читается как связь, а не как размер
    const tick = 3 * dpr;
    c.beginPath();
    if (axis === 'x') {
        c.moveTo(a.x, a.y - tick);
        c.lineTo(a.x, a.y + tick);
        c.moveTo(b.x, b.y - tick);
        c.lineTo(b.x, b.y + tick);
    } else {
        c.moveTo(a.x - tick, a.y);
        c.lineTo(a.x + tick, a.y);
        c.moveTo(b.x - tick, b.y);
        c.lineTo(b.x + tick, b.y);
    }
    c.stroke();
}

function hex2rgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
