/**
 * projection/result.js — Канвас результата: pan/zoom, джойстик, отображение
 */
'use strict';

import { projState } from '../core/projection-consts.js';

// ════════════════════════════════════════════════════════════
// Result canvas: zoom / pan / drag
// ════════════════════════════════════════════════════════════

export function projResultZoom(e) {
    e.preventDefault();
    const r = projState.result;
    r.scale = Math.min(8, Math.max(0.25, r.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    _applyResultTransform();
}

export function projResultDragStart(e) {
    const r = projState.result;
    r.dragging = true;
    r.startX   = e.clientX - r.ox;
    r.startY   = e.clientY - r.oy;
}

export function projResultDragMove(e) {
    const r = projState.result;
    if (!r.dragging) return;
    r.ox = e.clientX - r.startX;
    r.oy = e.clientY - r.startY;
    _applyResultTransform();
}

export function projResultDragEnd() {
    projState.result.dragging = false;
}

function _applyResultTransform() {
    const { scale, ox, oy } = projState.result;
    const target =
        document.getElementById('projResultCanvasImg') ||
        document.getElementById('projResultImg');
    if (target) {
        target.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    }
}

// ════════════════════════════════════════════════════════════
// Показ изображения warp-результата
// ════════════════════════════════════════════════════════════

export function showProjectionCanvas(bytes) {
    if (!bytes || !bytes.byteLength) return;

    const blob    = new Blob([bytes], { type: 'image/jpeg' });
    const url     = URL.createObjectURL(blob);
    const wrapper = document.getElementById('projResultCanvas');

    const canvasEl = document.getElementById('projResultImg');
    if (canvasEl) canvasEl.style.display = 'none';

    let img = document.getElementById('projResultCanvasImg');
    if (!img) {
        img = document.createElement('img');
        img.id = 'projResultCanvasImg';
        img.style.cssText =
            'position:absolute;max-width:100%;max-height:100%;' +
            'object-fit:contain;transform-origin:center;' +
            'user-select:none;pointer-events:none;z-index:1;';
        wrapper?.appendChild(img);
    }

    if (img._prevUrl) URL.revokeObjectURL(img._prevUrl);
    img.src      = url;
    img._prevUrl = url;

    projState.result.scale = 1;
    projState.result.ox    = 0;
    projState.result.oy    = 0;
    img.style.transform    = 'translate(0px, 0px) scale(1)';

    document.getElementById('noSignalResult')?.classList.add('hidden');
}

// ════════════════════════════════════════════════════════════
// Джойстик
// ════════════════════════════════════════════════════════════

export function initProjJoystick(sendWSMessage, getActiveCamera) {
    const nub = document.getElementById('projJoyNub');
    const joy = document.getElementById('projJoystick');
    if (!nub || !joy) return;

    const MAX_R = 30;
    let dragging = false, dx = 0, dy = 0, angle = 0;

    joy.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (!getActiveCamera()?.done) return;
        dragging = true;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = joy.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top  + rect.height / 2;
        let x = e.clientX - cx, y = e.clientY - cy;
        const dist = Math.hypot(x, y);
        if (dist > MAX_R) { x = x / dist * MAX_R; y = y / dist * MAX_R; }
        dx = x / MAX_R;
        dy = y / MAX_R;
        nub.style.transform = `translate(${x}px, ${y}px)`;
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        const cam = getActiveCamera();
        if (!cam?.done) return;
        sendWSMessage('projection_warp_apply', { dx, dy, angle });
        nub.style.transition = 'transform 0.2s ease';
        nub.style.transform  = 'translate(0,0)';
        setTimeout(() => nub.style.transition = '', 200);
    });
}