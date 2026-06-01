/**
 * projection/state.js — Состояние, константы, метки камер
 */
'use strict';

// ── Labels ───────────────────────────────────────────────────
export const PROJ_POSITION_LABELS = {
    front:       'Передняя',
    right:       'Правая',
    right_front: 'Спереди правая',
    right_back:  'Сзади правая',
    back:        'Задняя',
    left:        'Левая',
    left_back:   'Сзади левая',
    left_front:  'Спереди левая',
};

// ── State ────────────────────────────────────────────────────
export const projState = {
    settingsOpen: false,

    presets:      [],
    activePreset: null,

    activeCam:    null,

    pointsByCam:    {},
    points:         [],

    doneSet:        new Set(),
    maxPointsByCam: {},
    camId:          {},

    applied:  false,
    result:   { scale: 1, ox: 0, oy: 0, dragging: false, startX: 0, startY: 0 },
};

export const projView = {
    scale: 1,
    ox: 0,
    oy: 0,
    panning: false,
    panStartX: 0,
    panStartY: 0,
};

// ── Constants ────────────────────────────────────────────────
export const MIN_SCALE      = 1.0;
export const MAX_SCALE      = 8.0;
export const DRAG_THRESHOLD = 0.005;

// Базовый размер канваса (заполняется при инициализации)
export const projCanvasBase = { w: 0, h: 0 };

// ── Shared helpers (чистые чтения state, без сторонних импортов) ──
export function currentMaxPoints() {
    if (!projState.activeCam) return 0;
    return projState.maxPointsByCam[projState.activeCam] ?? 0;
}

export function projUpdateUI() {
    const n      = projState.points.length;
    const maxPts = currentMaxPoints();
    const badge  = document.getElementById('projPointBadge');
    if (badge) badge.textContent = `${n} / ${maxPts}`;
}