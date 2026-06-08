'use strict';

export const confState = {
    field: { w: 1000, h: 1000, step: 10 },
    tool:  'select',

    cameras: [],   // { id, key, name, x, y, w, h, color }
    zones:   [],   // { id, key, name, x, y, w, h, rotation, cameraId, color }
    images:  [],   // { id, name, x, y, w, h, img (HTMLImageElement) }

    selected: null, // { type: 'camera'|'zone'|'image', id }
    dragging: null, // { id, type, offsetX, offsetY }
    rotating: null, // { id, type }
    resize: null, // { id, type, handle }

    fixedZoneSize: { enabled: false, w: 100, h: 100 },
    exportScale: 1,

    view: { ox: 0, oy: 0, scale: 1 },
};

export const COLORS = {
    camera: ['#378ADD', '#D85A30', '#1D9E75', '#D4537E', '#BA7517', '#534AB7'],
    zone:   ['#85B7EB', '#F0997B', '#5DCAA5', '#ED93B1', '#FAC775', '#AFA9EC'],
};

export const HANDLE_SIZE = 5;
export const ROTATION_STALK = 24;

let _colorIdx = { camera: 0, zone: 0 };
export function nextColor(type) {
    const arr = COLORS[type];
    const c   = arr[_colorIdx[type] % arr.length];
    _colorIdx[type]++;
    return c;
}

let _idCounter = 0;
export function uid() { return `el_${Date.now()}_${_idCounter++}`; }