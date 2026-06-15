/**
 * projection/cam-list.js — Список камер пресета, выбор камеры
 */
'use strict';

import { projState, PROJ_POSITION_LABELS, projUpdateUI } from '../core/projection-consts.js';
import { projDraw } from './canvas.js';

// ════════════════════════════════════════════════════════════
// Рендер списка камер
// ════════════════════════════════════════════════════════════

export function renderProjCamList() {
    const list = document.getElementById('projCamList');
    if (!list) return;
    list.innerHTML = '';

    const cams = projState.activePreset?.cameras ?? [];
    if (!cams.length) {
        list.innerHTML = `<div class="proj-cam-empty">Выберите конфигурацию</div>`;
        return;
    }

    cams.forEach(cam => {
        const baseLabel = cam.name || cam.key || "undefined";
        const camId     = projState.camId?.[cam.key];
        const label     = camId
            ? `${baseLabel} <span class="proj-cam-id">[${camId}]</span>`
            : baseLabel;

        const isActive  = projState.activeCam === cam.key;
        const isDone    = projState.doneSet.has(cam.key);
        const liveCount = isActive
            ? projState.points.length
            : (projState.pointsByCam[cam.key]?.length ?? 0);
        const maxPoints = cam.max_points ?? 0;

        const el = document.createElement('div');
        el.className = 'proj-cam-item' + (isActive ? ' active' : '');
        el.innerHTML = `
            <div class="proj-cam-radio"></div>
            <span class="proj-cam-name">${label}</span>
            <span class="proj-cam-count">${liveCount}/${maxPoints}</span>
            <div class="proj-cam-done ${isDone ? 'done' : ''}"></div>
        `;
        el.onclick = () => selectProjCamera(cam.key);
        list.appendChild(el);
    });

    updateLutButtonState();
}

// ════════════════════════════════════════════════════════════
// Выбор камеры
// ════════════════════════════════════════════════════════════

export function selectProjCamera(key) {
    projState.activeCam = key;
    projState.applied   = false;
    document.getElementById('projWarpWrapper')?.classList.remove('applied');

    projState.points = (projState.pointsByCam[key] ?? []).slice();

    renderProjCamList();
    projUpdateUI();
    projDraw();
}

// ════════════════════════════════════════════════════════════
// LUT button state
// ════════════════════════════════════════════════════════════

export function updateLutButtonState() {
    const btn = document.querySelector('.proj-lut-btn');
    if (!btn) return;

    const cams    = projState.activePreset?.cameras ?? [];
    const allDone = cams.length > 0 && cams.every(c => projState.doneSet.has(c.key));

    btn.disabled = !allDone;
    btn.title = allDone
        ? 'Сохранить конфигурацию stitching'
        : 'Доступно после применения warp на всех камерах';
}