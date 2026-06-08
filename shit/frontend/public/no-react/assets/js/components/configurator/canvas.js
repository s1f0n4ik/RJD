'use strict';

import { confState, HANDLE_SIZE, ROTATION_STALK } from '../../core/conf-state.js';

let _canvas, _ctx;
let _dpr = 1;

export function initConfCanvas() {
    _canvas = document.getElementById('confCanvas');
    _ctx    = _canvas.getContext('2d');
    _dpr    = window.devicePixelRatio || 1;

    new ResizeObserver(_resize).observe(_canvas.parentElement);
    _resize();
}

function _resize() {
    const area = _canvas.parentElement;
    _canvas.width  = Math.round(area.offsetWidth  * _dpr);
    _canvas.height = Math.round(area.offsetHeight * _dpr);
    confDraw();
}

// ── Мировые координаты ↔ canvas ──────────────────────────
export function worldToCanvas(wx, wy) {
    const v = confState.view;
    return {
        x: (wx * v.scale + v.ox) * _dpr,
        y: (wy * v.scale + v.oy) * _dpr,
    };
}

export function canvasToWorld(cx, cy) {
    const v = confState.view;
    const rect = _canvas.getBoundingClientRect();
    return {
        x: (cx - rect.left - v.ox) / v.scale,
        y: (cy - rect.top  - v.oy) / v.scale,
    };
}

export function snap(val) {
    const s = confState.field.step;
    return Math.round(val / s) * s;
}

export function clampToField(x, y, w, h) {
    const f = confState.field;
    return {
        x: Math.max(0, Math.min(f.w - w, x)),
        y: Math.max(0, Math.min(f.h - h, y)),
    };
}

// ── Рендер ────────────────────────────────────────────────
export function confDraw() {
    if (!_ctx) return;
    const W = _canvas.width, H = _canvas.height;
    _ctx.clearRect(0, 0, W, H);

    _drawGrid();
    _drawImages();
    _drawCameras();
    _drawZones();
    _drawSelection();
    _updateStatusBar();
}

function _drawGrid() {
    const f = confState.field;
    const s = confState.field.step;
    const v = confState.view;

    // Границы поля
    const tl = worldToCanvas(0, 0);
    const br = worldToCanvas(f.w, f.h);
    const fw = br.x - tl.x;
    const fh = br.y - tl.y;

    // Фон поля
    _ctx.fillStyle = 'rgba(22,22,29,0.9)';
    _ctx.fillRect(tl.x, tl.y, fw, fh);

    // Сетка
    const stepPx = s * v.scale * _dpr;
    if (stepPx > 6) {
        _ctx.strokeStyle = 'rgba(37,37,48,0.6)';
        _ctx.lineWidth   = 1;
        _ctx.beginPath();
        for (let wx = s; wx < f.w; wx += s) {
            const { x } = worldToCanvas(wx, 0);
            _ctx.moveTo(x, tl.y);
            _ctx.lineTo(x, br.y);
        }
        for (let wy = s; wy < f.h; wy += s) {
            const { y } = worldToCanvas(0, wy);
            _ctx.moveTo(tl.x, y);
            _ctx.lineTo(br.x, y);
        }
        _ctx.stroke();
    }

    // Рамка поля
    _ctx.strokeStyle = 'rgba(200,255,64,0.3)';
    _ctx.lineWidth   = 2 * _dpr;
    _ctx.strokeRect(tl.x, tl.y, fw, fh);
}

function _drawCameras() {
    confState.cameras.forEach(cam => {
        const tl = worldToCanvas(cam.x, cam.y);
        const br = worldToCanvas(cam.x + cam.w, cam.y + cam.h);
        const w  = br.x - tl.x, h = br.y - tl.y;

        _ctx.fillStyle   = _hex2rgba(cam.color, 0.12);
        _ctx.strokeStyle = cam.color;
        _ctx.lineWidth   = 1.5 * _dpr;
        _ctx.fillRect(tl.x, tl.y, w, h);
        _ctx.strokeRect(tl.x, tl.y, w, h);

        _ctx.fillStyle    = cam.color;
        _ctx.font         = `bold ${11 * _dpr}px monospace`;
        _ctx.textAlign    = 'left';
        _ctx.textBaseline = 'top';
        _ctx.fillText(cam.name, tl.x + 4 * _dpr, tl.y + 4 * _dpr);
    });
}

function _drawZones() {
    confState.zones.forEach(zone => {
        const camZones = confState.zones.filter(z => z.cameraId === zone.cameraId);
        const indexInCam = camZones.indexOf(zone) + 1;

        const tl = worldToCanvas(zone.x, zone.y);
        const br = worldToCanvas(zone.x + zone.w, zone.y + zone.h);
        const w  = br.x - tl.x, h = br.y - tl.y;
        const cx = tl.x + w / 2;
        const cy = tl.y + h / 2;
        const rad = zone.rotation * Math.PI / 180;

        _ctx.save();
        _ctx.translate(cx, cy);
        _ctx.rotate(rad);

        // Заливка + рамка
        _ctx.fillStyle   = _hex2rgba(zone.color, 0.15);
        _ctx.strokeStyle = zone.color;
        _ctx.lineWidth   = 1 * _dpr;
        _ctx.setLineDash([4 * _dpr, 3 * _dpr]);
        _ctx.fillRect(-w / 2, -h / 2, w, h);
        _ctx.strokeRect(-w / 2, -h / 2, w, h);
        _ctx.setLineDash([]);

        // Стрелка «вниз» — относительно rotation
        const arrowLen = Math.min(w, h) * 0.25;
        const arrowY   = h * 0.15;
        _ctx.beginPath();
        _ctx.moveTo(0, arrowY - arrowLen * 0.4);
        _ctx.lineTo(0, arrowY + arrowLen * 0.4);
        _ctx.strokeStyle = zone.color;
        _ctx.lineWidth   = 2.5 * _dpr;
        _ctx.stroke();

        // Наконечник
        _ctx.beginPath();
        _ctx.moveTo(-arrowLen * 0.22, arrowY + arrowLen * 0.1);
        _ctx.lineTo(0, arrowY + arrowLen * 0.4);
        _ctx.lineTo(arrowLen * 0.22, arrowY + arrowLen * 0.1);
        _ctx.stroke();

        // Номер зоны внутри камеры — крупный, рядом со стрелкой
        const numSize = Math.min(w, h) * 0.3;
        const fontSize = Math.max(12 * _dpr, Math.min(numSize, 28 * _dpr));
        _ctx.fillStyle    = zone.color;
        _ctx.font         = `bold ${fontSize}px monospace`;
        _ctx.textAlign    = 'center';
        _ctx.textBaseline = 'middle';
        _ctx.globalAlpha  = 0.6;
        _ctx.fillText(String(indexInCam), 0, -h * 0.15);
        _ctx.globalAlpha  = 1;

        // Имя — левый верхний угол
        _ctx.fillStyle    = zone.color;
        _ctx.font         = `${10 * _dpr}px monospace`;
        _ctx.textAlign    = 'left';
        _ctx.textBaseline = 'top';
        _ctx.fillText(zone.name, -w / 2 + 3 * _dpr, -h / 2 + 3 * _dpr);

        _ctx.restore();
    });
}

export function clampZoneToCamera(zone) {
    const cam = confState.cameras.find(c => c.id === zone.cameraId);
    if (!cam) return;

    zone.x = Math.max(cam.x, Math.min(cam.x + cam.w - zone.w, zone.x));
    zone.y = Math.max(cam.y, Math.min(cam.y + cam.h - zone.h, zone.y));

    // Если зона больше камеры — обрезать
    if (zone.w > cam.w) zone.w = cam.w;
    if (zone.h > cam.h) zone.h = cam.h;
}

function _drawImages() {
    confState.images.forEach(img => {
        if (!img.img) return;
        const tl = worldToCanvas(img.x, img.y);
        const br = worldToCanvas(img.x + img.w, img.y + img.h);
        _ctx.drawImage(img.img, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    });
}

function _drawSelection() {
    const sel = confState.selected;
    if (!sel) return;

    let item;
    if (sel.type === 'camera') item = confState.cameras.find(c => c.id === sel.id);
    if (sel.type === 'zone')   item = confState.zones.find(z => z.id === sel.id);
    if (sel.type === 'image')  item = confState.images.find(i => i.id === sel.id);
    if (!item) return;

    const tl = worldToCanvas(item.x, item.y);
    const br = worldToCanvas(item.x + item.w, item.y + item.h);
    const w  = br.x - tl.x;
    const h  = br.y - tl.y;

    const hs = HANDLE_SIZE * _dpr;

    if (sel.type === 'zone') {
        // Для зон рисуем selection + handles с учётом rotation
        const cx  = tl.x + w / 2;
        const cy  = tl.y + h / 2;
        const rad = item.rotation * Math.PI / 180;

        _ctx.save();
        _ctx.translate(cx, cy);
        _ctx.rotate(rad);

        // Рамка
        _ctx.strokeStyle = '#c8ff40';
        _ctx.lineWidth   = 2 * _dpr;
        _ctx.setLineDash([6 * _dpr, 3 * _dpr]);
        _ctx.strokeRect(-w / 2, -h / 2, w, h);
        _ctx.setLineDash([]);

        // 8 handle
        const handles = [
            [-w/2, -h/2], [0, -h/2], [w/2, -h/2],
            [-w/2, 0],               [w/2, 0],
            [-w/2, h/2],  [0, h/2],  [w/2, h/2],
        ];
        _ctx.fillStyle = '#c8ff40';
        for (const [px, py] of handles) {
            _ctx.fillRect(px - hs, py - hs, hs * 2, hs * 2);
        }

        // Handle поворота — круг сверху на ножке
        const stalkLen = 24 * _dpr;
        const rotHandleY = -h / 2 - stalkLen;

        // Ножка
        _ctx.beginPath();
        _ctx.moveTo(0, -h / 2);
        _ctx.lineTo(0, rotHandleY);
        _ctx.strokeStyle = '#c8ff40';
        _ctx.lineWidth   = 1.5 * _dpr;
        _ctx.setLineDash([]);
        _ctx.stroke();

        // Кружок
        _ctx.beginPath();
        _ctx.arc(0, rotHandleY, 5 * _dpr, 0, Math.PI * 2);
        _ctx.fillStyle   = '#0a0a0c';
        _ctx.strokeStyle = '#c8ff40';
        _ctx.lineWidth   = 1.5 * _dpr;
        _ctx.fill();
        _ctx.stroke();

        // Дуга внутри кружка
        _ctx.beginPath();
        _ctx.arc(0, rotHandleY, 3 * _dpr, -Math.PI * 0.7, Math.PI * 0.4);
        _ctx.strokeStyle = '#c8ff40';
        _ctx.lineWidth   = 1 * _dpr;
        _ctx.stroke();

        _ctx.restore();
    } else {
        // Камеры и изображения — без rotation
        _ctx.strokeStyle = '#c8ff40';
        _ctx.lineWidth   = 2 * _dpr;
        _ctx.setLineDash([6 * _dpr, 3 * _dpr]);
        _ctx.strokeRect(tl.x, tl.y, w, h);
        _ctx.setLineDash([]);

        const handles = [
            [tl.x,         tl.y        ],
            [tl.x + w / 2, tl.y        ],
            [br.x,         tl.y        ],
            [tl.x,         tl.y + h / 2],
            [br.x,         tl.y + h / 2],
            [tl.x,         br.y        ],
            [tl.x + w / 2, br.y        ],
            [br.x,         br.y        ],
        ];
        _ctx.fillStyle = '#c8ff40';
        for (const [px, py] of handles) {
            _ctx.fillRect(px - hs, py - hs, hs * 2, hs * 2);
        }
    }
}

function _updateStatusBar() {
    const f = confState.field;
    document.getElementById('confFieldSize').textContent = `Поле: ${f.w}×${f.h}`;
    const stepEl = document.querySelector('#confSnapStep.meta-tag') ||
        document.querySelector('.conf-status-bar .meta-tag:nth-child(2)');
    if (stepEl) stepEl.textContent = `Шаг: ${f.step}`;
}

function _hex2rgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}