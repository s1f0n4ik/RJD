/**
 * projection/warp-canvas.js — Канвас для расстановки точек, zoom/pan
 */
'use strict';

import { showToast } from '../utils/utility.js';
import {
    projState, projView, projCanvasBase,
    MIN_SCALE, MAX_SCALE, DRAG_THRESHOLD,
    currentMaxPoints, projUpdateUI,
} from '../core/projection-consts.js';

// ── Drag state (локальные для модуля) ────────────────────────
let _draggingPoint = null;
let _dragMoved     = false;
let _dragStartX    = 0;
let _dragStartY    = 0;
let _lastAppliedScale = 1;

// Внешний рендер списка камер — устанавливается через setter,
// чтобы не создавать циклический импорт с cam-list.js
let _renderCamListFn = () => {};
export function setRenderCamList(fn) { _renderCamListFn = fn; }

// ════════════════════════════════════════════════════════════
// Init
// ════════════════════════════════════════════════════════════

export function initProjWarpCanvas() {
    const canvas  = document.getElementById('projWarpCanvas');
    const wrapper = document.getElementById('uiCanvasLayer');
    const video   = document.getElementById('remoteVideo');

    canvas.addEventListener('pointerdown', _pointerDown);
    canvas.addEventListener('pointermove', _pointerMove);
    canvas.addEventListener('pointerup',   _pointerUp);

    function resizeCanvas() {
        const vw = video?.videoWidth;
        const vh = video?.videoHeight;

        let canvasW, canvasH;
        if (vw && vh) {
            const wrapperRatio = wrapper.offsetWidth / wrapper.offsetHeight;
            const videoRatio   = vw / vh;
            if (videoRatio > wrapperRatio) {
                canvasW = wrapper.offsetWidth;
                canvasH = Math.round(wrapper.offsetWidth / videoRatio);
            } else {
                canvasH = wrapper.offsetHeight;
                canvasW = Math.round(wrapper.offsetHeight * videoRatio);
            }
        } else {
            canvasW = wrapper.offsetWidth;
            canvasH = wrapper.offsetHeight;
        }

        projCanvasBase.w = canvasW;
        projCanvasBase.h = canvasH;

        canvas.style.width    = canvasW + 'px';
        canvas.style.height   = canvasH + 'px';
        canvas.style.position = 'absolute';
        canvas.style.left = Math.round((wrapper.offsetWidth  - canvasW) / 2) + 'px';
        canvas.style.top  = Math.round((wrapper.offsetHeight - canvasH) / 2) + 'px';

        resizeCanvasBitmap();
    }

    new ResizeObserver(resizeCanvas).observe(wrapper);
    if (video) {
        video.addEventListener('loadedmetadata', resizeCanvas);
        if (video.readyState >= 1) resizeCanvas();
    }
}

// ════════════════════════════════════════════════════════════
// Bitmap resize
// ════════════════════════════════════════════════════════════

export function resizeCanvasBitmap() {
    const canvas = document.getElementById('projWarpCanvas');
    if (!canvas || !projCanvasBase.w) return;

    const dpr = window.devicePixelRatio || 1;
    const s   = projView.scale ?? 1;

    canvas.width  = Math.round(projCanvasBase.w * s * dpr);
    canvas.height = Math.round(projCanvasBase.h * s * dpr);

    projDraw();
}

// ════════════════════════════════════════════════════════════
// Normalized coords + hit test
// ════════════════════════════════════════════════════════════

function _getNorm(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (event.clientY - rect.top)  / rect.height)),
    };
}

function _hitPoint(nx, ny) {
    const canvas = document.getElementById('projWarpCanvas');
    if (!canvas.width || !canvas.height) return -1;

    const s      = projView.scale || 1;
    const HIT_PX = 14 / s;
    const hitNX  = HIT_PX / canvas.width;
    const hitNY  = HIT_PX / canvas.height;

    for (let i = projState.points.length - 1; i >= 0; i--) {
        const p  = projState.points[i];
        const dx = (p.x - nx) / hitNX;
        const dy = (p.y - ny) / hitNY;
        if (dx * dx + dy * dy < 1) return i;
    }
    return -1;
}

// ════════════════════════════════════════════════════════════
// Pointer events
// ════════════════════════════════════════════════════════════

function _pointerDown(e) {
    if (projState.applied) return;
    if (e.ctrlKey || e.shiftKey) return;

    if (!projState.activeCam) {
        showToast('Камера не выбрана', 'Выберите камеру в настройках', 'err');
        return;
    }

    const canvas   = e.currentTarget;
    const { x, y } = _getNorm(canvas, e);

    _dragStartX    = x;
    _dragStartY    = y;
    _dragMoved     = false;
    _draggingPoint = _hitPoint(x, y);

    if (_draggingPoint !== -1) canvas.setPointerCapture(e.pointerId);
}

function _pointerMove(e) {
    if (projState.applied || !projState.activeCam) return;
    if (_draggingPoint === -1 || _draggingPoint === null) return;

    const { x, y } = _getNorm(e.currentTarget, e);

    if (!_dragMoved) {
        if (Math.hypot(x - _dragStartX, y - _dragStartY) < DRAG_THRESHOLD) return;
        _dragMoved = true;
    }

    projState.points[_draggingPoint].x = x;
    projState.points[_draggingPoint].y = y;
    projDraw();
}

function _pointerUp(e) {
    if (projState.applied || !projState.activeCam) return;
    if (e.ctrlKey || e.shiftKey) return;

    const canvas      = e.currentTarget;
    const hitExisting = _draggingPoint !== -1 && _draggingPoint !== null;
    const wasDrag     = _dragMoved;

    if (hitExisting) canvas.releasePointerCapture(e.pointerId);
    _draggingPoint = null;
    _dragMoved     = false;

    if (!hitExisting && !wasDrag) {
        const maxPts = currentMaxPoints();
        if (maxPts <= 0) {
            showToast('Лимит не получен', 'Камера не содержит max_points', 'err');
            return;
        }
        if (projState.points.length >= maxPts) {
            showToast('Лимит точек', `Максимум ${maxPts}`, 'warn');
            return;
        }
        const { x, y } = _getNorm(canvas, e);
        projState.points.push({ x, y, id: Date.now() });
        projUpdateUI();
        _renderCamListFn();
    }

    projDraw();
}

// ════════════════════════════════════════════════════════════
// Draw
// ════════════════════════════════════════════════════════════

export function projDraw() {
    const canvas = document.getElementById('projWarpCanvas');
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    const pts = projState.points;
    if (!pts.length) return;

    const dpr = window.devicePixelRatio || 1;
    const PX  = dpr;

    const toPx = p => ({ x: p.x * W, y: p.y * H });

    const R      = 7   * PX;
    const RING   = 3   * PX;
    const LINE_W = 1.5 * PX;
    const FONT   = 11  * PX;

    // Пунктирные линии между точками
    if (pts.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(200,255,64,0.4)';
        ctx.lineWidth   = LINE_W;
        ctx.setLineDash([5 * PX, 4 * PX]);
        pts.forEach((p, i) => {
            const px = toPx(p);
            i === 0 ? ctx.moveTo(px.x, px.y) : ctx.lineTo(px.x, px.y);
        });
        if (pts.length === currentMaxPoints()) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Точки
    pts.forEach((p, i) => {
        const { x, y } = toPx(p);

        ctx.beginPath();
        ctx.arc(x, y, R + RING, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fillStyle   = '#c8ff40';
        ctx.strokeStyle = '#0a0a0c';
        ctx.lineWidth   = LINE_W;
        ctx.fill();
        ctx.stroke();

        const label = String(i + 1);
        ctx.font         = `bold ${FONT}px monospace`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        const tw  = ctx.measureText(label).width;
        const lx  = x + R + 6 * PX;
        const ly  = y;
        const pad = 3 * PX;

        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(lx - pad, ly - 8 * PX, tw + pad * 2, 16 * PX, 3 * PX);
        ctx.fill();

        ctx.fillStyle = '#c8ff40';
        ctx.fillText(label, lx, ly);
    });
}

// ════════════════════════════════════════════════════════════
// Zoom / Pan
// ════════════════════════════════════════════════════════════

function _applyWarpTransform() {
    const layer = document.getElementById('uiCanvasLayer');
    if (!layer) return;
    layer.style.transform =
        `translate(${projView.ox}px, ${projView.oy}px) scale(${projView.scale})`;

    if (projView.scale !== _lastAppliedScale) {
        _lastAppliedScale = projView.scale;
        resizeCanvasBitmap();
    } else {
        projDraw();
    }
}

function _clampPan() {
    const wrapper = document.getElementById('projWarpWrapper');
    const layer   = document.getElementById('uiCanvasLayer');
    if (!wrapper || !layer) return;

    const wRect   = wrapper.getBoundingClientRect();
    const baseW   = layer.offsetWidth;
    const baseH   = layer.offsetHeight;
    const scaledW = baseW * projView.scale;
    const scaledH = baseH * projView.scale;

    projView.ox = scaledW <= wRect.width
        ? (wRect.width - scaledW) / 2
        : Math.min(0, Math.max(wRect.width - scaledW, projView.ox));

    projView.oy = scaledH <= wRect.height
        ? (wRect.height - scaledH) / 2
        : Math.min(0, Math.max(wRect.height - scaledH, projView.oy));
}

function _onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();

    const wrapper = document.getElementById('projWarpWrapper');
    const rect    = wrapper.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const prev   = projView.scale;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next   = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * factor));
    if (next === prev) return;

    const ratio  = next / prev;
    projView.ox    = mx - (mx - projView.ox) * ratio;
    projView.oy    = my - (my - projView.oy) * ratio;
    projView.scale = next;

    _clampPan();
    _applyWarpTransform();
}

function _onPanDown(e) {
    const usePan = (e.button === 1) || (e.button === 0 && e.shiftKey);
    if (!usePan) return;
    e.preventDefault();
    projView.panning   = true;
    projView.panStartX = e.clientX - projView.ox;
    projView.panStartY = e.clientY - projView.oy;
    document.getElementById('projWarpWrapper')?.classList.add('panning');
}

function _onPanMove(e) {
    if (!projView.panning) return;
    projView.ox = e.clientX - projView.panStartX;
    projView.oy = e.clientY - projView.panStartY;
    _clampPan();
    _applyWarpTransform();
}

function _onPanUp() {
    if (!projView.panning) return;
    projView.panning = false;
    document.getElementById('projWarpWrapper')?.classList.remove('panning');
}

export function initWarpZoomPan() {
    const wrapper = document.getElementById('projWarpWrapper');
    if (!wrapper) return;

    wrapper.addEventListener('wheel', _onWheel, { passive: false });
    wrapper.addEventListener('pointerdown', _onPanDown);
    window.addEventListener('pointermove', _onPanMove);
    window.addEventListener('pointerup',   _onPanUp);

    new ResizeObserver(() => {
        _clampPan();
        _applyWarpTransform();
    }).observe(wrapper);

    _applyWarpTransform();
}

export function projResetView() {
    projView.scale = 1;
    projView.ox    = 0;
    projView.oy    = 0;
    _clampPan();
    _applyWarpTransform();
}

// ════════════════════════════════════════════════════════════
// Точки: удалить / очистить / применить
// ════════════════════════════════════════════════════════════

export function projRemoveLastPoint() {
    projState.points.pop();
    projDraw();
    projUpdateUI();
    _renderCamListFn();
}

export function projClearPoints() {
    projState.points  = [];
    projState.applied = false;
    document.getElementById('projWarpWrapper')?.classList.remove('applied');
    const applyBtn  = document.getElementById('projApplyBtn');
    if (applyBtn)   applyBtn.textContent = '⊛ Применить warp';
    const editState = document.getElementById('projEditState');
    if (editState)  editState.textContent = 'Режим: редактирование';
    projDraw();
    projUpdateUI();
    _renderCamListFn();
}