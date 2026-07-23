import { confState, HANDLE_SIZE } from '../../state/conf-store';
import type { ConfZone } from '../../types';
import { CANVAS_COLORS } from '../../styles/canvas-colors';

/**
 * Отрисовка холста конфигуратора. Порт canvas.js из no-react без изменения
 * логики рендера.
 *
 * Модуль намеренно императивный: рисование идёт по требованию (confDraw после
 * каждой мутации confState), RAF-цикла нет, React в отрисовке не участвует.
 * Статус-бар сюда больше не пишет — им занимается компонент.
 */

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
    return Math.round(val / s) * s;
}

export function clampToField(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const f = confState.field;
    return {
        x: Math.max(0, Math.min(f.w - w, x)),
        y: Math.max(0, Math.min(f.h - h, y)),
    };
}

/**
 * Полуразмеры повёрнутого прямоугольника вдоль осей мира.
 *
 * Зона хранится как AABB плюс угол, но на холст и в экспорт уходят повёрнутые
 * углы. Пережимать по неповёрнутому прямоугольнику нельзя — после поворота
 * углы вылезают за камеру, а в dst_points появляются отрицательные координаты.
 */
export function rotatedHalfExtents(w: number, h: number, rotationDeg: number): { hw: number; hh: number } {
    const rad = (rotationDeg * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    return {
        hw: (w / 2) * c + (h / 2) * s,
        hh: (w / 2) * s + (h / 2) * c,
    };
}

/** Загоняет зону внутрь её камеры с учётом поворота. */
export function clampZoneToCamera(zone: ConfZone): void {
    const cam = confState.cameras.find(c => c.id === zone.cameraId);
    if (!cam) return;

    let ext = rotatedHalfExtents(zone.w, zone.h, zone.rotation);

    // Повёрнутая зона может не влезать в камеру — ужимаем, сохраняя пропорции
    if (ext.hw > 0 && ext.hh > 0) {
        const fit = Math.min(cam.w / (ext.hw * 2), cam.h / (ext.hh * 2), 1);
        if (fit < 1) {
            zone.w = Math.max(1, Math.round(zone.w * fit));
            zone.h = Math.max(1, Math.round(zone.h * fit));
            ext = rotatedHalfExtents(zone.w, zone.h, zone.rotation);
        }
    }

    const cx = Math.max(cam.x + ext.hw, Math.min(cam.x + cam.w - ext.hw, zone.x + zone.w / 2));
    const cy = Math.max(cam.y + ext.hh, Math.min(cam.y + cam.h - ext.hh, zone.y + zone.h / 2));

    zone.x = cx - zone.w / 2;
    zone.y = cy - zone.h / 2;
}

export function confDraw(): void {
    if (!ctx || !canvasEl) return;
    const W = canvasEl.width;
    const H = canvasEl.height;
    ctx.clearRect(0, 0, W, H);

    drawGrid(ctx);
    drawImages(ctx);
    drawCameras(ctx);
    drawZones(ctx);
    drawSelection(ctx);
    drawDraft(ctx);
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
    c.fillText(`${Math.round(d.w)}×${Math.round(d.h)}`, tl.x, tl.y - 4 * dpr);
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

function drawZones(c: CanvasRenderingContext2D): void {
    confState.zones.forEach(zone => {
        const camZones = confState.zones.filter(z => z.cameraId === zone.cameraId);
        const indexInCam = camZones.indexOf(zone) + 1;

        const tl = worldToCanvas(zone.x, zone.y);
        const br = worldToCanvas(zone.x + zone.w, zone.y + zone.h);
        const w = br.x - tl.x;
        const h = br.y - tl.y;
        const cx = tl.x + w / 2;
        const cy = tl.y + h / 2;
        const rad = (zone.rotation * Math.PI) / 180;

        c.save();
        c.translate(cx, cy);
        c.rotate(rad);

        // Заливка + рамка
        c.fillStyle = hex2rgba(zone.color, 0.15);
        c.strokeStyle = zone.color;
        c.lineWidth = 1 * dpr;
        c.setLineDash([4 * dpr, 3 * dpr]);
        c.fillRect(-w / 2, -h / 2, w, h);
        c.strokeRect(-w / 2, -h / 2, w, h);
        c.setLineDash([]);

        // Стрелка «вниз» — относительно rotation
        const arrowLen = Math.min(w, h) * 0.25;
        const arrowY = h * 0.15;
        c.beginPath();
        c.moveTo(0, arrowY - arrowLen * 0.4);
        c.lineTo(0, arrowY + arrowLen * 0.4);
        c.strokeStyle = zone.color;
        c.lineWidth = 2.5 * dpr;
        c.stroke();

        // Наконечник
        c.beginPath();
        c.moveTo(-arrowLen * 0.22, arrowY + arrowLen * 0.1);
        c.lineTo(0, arrowY + arrowLen * 0.4);
        c.lineTo(arrowLen * 0.22, arrowY + arrowLen * 0.1);
        c.stroke();

        // Номер зоны внутри камеры — крупный, рядом со стрелкой
        const numSize = Math.min(w, h) * 0.3;
        const fontSize = Math.max(12 * dpr, Math.min(numSize, 28 * dpr));
        c.fillStyle = zone.color;
        c.font = `bold ${fontSize}px monospace`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.globalAlpha = 0.6;
        c.fillText(String(indexInCam), 0, -h * 0.15);
        c.globalAlpha = 1;

        // Имя — левый верхний угол
        c.fillStyle = zone.color;
        c.font = `${10 * dpr}px monospace`;
        c.textAlign = 'left';
        c.textBaseline = 'top';
        c.fillText(zone.name, -w / 2 + 3 * dpr, -h / 2 + 3 * dpr);

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
    if (!item) return;

    const tl = worldToCanvas(item.x, item.y);
    const br = worldToCanvas(item.x + item.w, item.y + item.h);
    const w = br.x - tl.x;
    const h = br.y - tl.y;

    const hs = HANDLE_SIZE * dpr;

    if (sel.type === 'zone') {
        // Для зон рисуем selection + handles с учётом rotation
        const cx = tl.x + w / 2;
        const cy = tl.y + h / 2;
        const rad = ((item as ConfZone).rotation * Math.PI) / 180;

        c.save();
        c.translate(cx, cy);
        c.rotate(rad);

        // Рамка
        c.strokeStyle = CANVAS_COLORS.accent;
        c.lineWidth = 2 * dpr;
        c.setLineDash([6 * dpr, 3 * dpr]);
        c.strokeRect(-w / 2, -h / 2, w, h);
        c.setLineDash([]);

        // 8 handle
        const handles: Array<[number, number]> = [
            [-w / 2, -h / 2], [0, -h / 2], [w / 2, -h / 2],
            [-w / 2, 0], [w / 2, 0],
            [-w / 2, h / 2], [0, h / 2], [w / 2, h / 2],
        ];
        c.fillStyle = CANVAS_COLORS.accent;
        for (const [px, py] of handles) {
            c.fillRect(px - hs, py - hs, hs * 2, hs * 2);
        }

        // Handle поворота — круг сверху на ножке
        const stalkLen = 24 * dpr;
        const rotHandleY = -h / 2 - stalkLen;

        // Ножка
        c.beginPath();
        c.moveTo(0, -h / 2);
        c.lineTo(0, rotHandleY);
        c.strokeStyle = CANVAS_COLORS.accent;
        c.lineWidth = 1.5 * dpr;
        c.setLineDash([]);
        c.stroke();

        // Кружок
        c.beginPath();
        c.arc(0, rotHandleY, 5 * dpr, 0, Math.PI * 2);
        c.fillStyle = CANVAS_COLORS.base;
        c.strokeStyle = CANVAS_COLORS.accent;
        c.lineWidth = 1.5 * dpr;
        c.fill();
        c.stroke();

        // Дуга внутри кружка
        c.beginPath();
        c.arc(0, rotHandleY, 3 * dpr, -Math.PI * 0.7, Math.PI * 0.4);
        c.strokeStyle = CANVAS_COLORS.accent;
        c.lineWidth = 1 * dpr;
        c.stroke();

        c.restore();
    } else {
        // Камеры и изображения — без rotation
        c.strokeStyle = CANVAS_COLORS.accent;
        c.lineWidth = 2 * dpr;
        c.setLineDash([6 * dpr, 3 * dpr]);
        c.strokeRect(tl.x, tl.y, w, h);
        c.setLineDash([]);

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
}

function hex2rgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
