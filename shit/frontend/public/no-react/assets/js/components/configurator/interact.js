'use strict';

import { confState, HANDLE_SIZE, ROTATION_STALK } from '../../core/conf-state.js';
import { canvasToWorld, snap, clampToField, confDraw, clampZoneToCamera } from './canvas.js';
import { renderAllLists } from './panel.js';

export function initConfInteract() {
    const canvas = document.getElementById('confCanvas');

    canvas.addEventListener('pointerdown', _onDown);
    canvas.addEventListener('pointermove', _onMove);
    canvas.addEventListener('pointerup',   _onUp);
    canvas.addEventListener('wheel', _onWheel, { passive: false });

    window.addEventListener('keydown', _onKey);
}

// ── Списки ───────────────────────────────────────────────

function _getList(type) {
    if (type === 'camera') return confState.cameras;
    if (type === 'zone')   return confState.zones;
    if (type === 'image')  return confState.images;
    return [];
}

// ── Hit test элементов ───────────────────────────────────

function _hitTest(wx, wy) {
    for (let i = confState.zones.length - 1; i >= 0; i--) {
        const z = confState.zones[i];
        if (wx >= z.x && wx <= z.x + z.w && wy >= z.y && wy <= z.y + z.h)
            return { type: 'zone', id: z.id };
    }
    for (let i = confState.cameras.length - 1; i >= 0; i--) {
        const c = confState.cameras[i];
        if (wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h)
            return { type: 'camera', id: c.id };
    }
    for (let i = confState.images.length - 1; i >= 0; i--) {
        const img = confState.images[i];
        if (wx >= img.x && wx <= img.x + img.w && wy >= img.y && wy <= img.y + img.h)
            return { type: 'image', id: img.id };
    }
    return null;
}

// ── Hit test handle — в мировых координатах ──────────────

function _hitHandle(item, wx, wy) {
    const hitR = (HANDLE_SIZE + 2) / confState.view.scale;

    // Для зон — координаты нужно повернуть обратно
    let lx = wx, ly = wy;
    if (item.rotation) {
        const cx = item.x + item.w / 2;
        const cy = item.y + item.h / 2;
        const rad = -item.rotation * Math.PI / 180;
        const dx = wx - cx, dy = wy - cy;
        lx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
        ly = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    }

    // Handle поворота — проверять только для зон
    if (item.cameraId !== undefined) {
        const stalkWorld = ROTATION_STALK / confState.view.scale;
        const rotHx = item.x + item.w / 2;
        const rotHy = item.y - stalkWorld;
        if (Math.abs(lx - rotHx) <= hitR * 1.5 && Math.abs(ly - rotHy) <= hitR * 1.5) {
            return 'rotate';
        }
    }

    const handles = [
        { name: 'tl', hx: item.x,              hy: item.y               },
        { name: 'mt', hx: item.x + item.w / 2, hy: item.y               },
        { name: 'tr', hx: item.x + item.w,     hy: item.y               },
        { name: 'ml', hx: item.x,              hy: item.y + item.h / 2  },
        { name: 'mr', hx: item.x + item.w,     hy: item.y + item.h / 2  },
        { name: 'bl', hx: item.x,              hy: item.y + item.h      },
        { name: 'mb', hx: item.x + item.w / 2, hy: item.y + item.h      },
        { name: 'br', hx: item.x + item.w,     hy: item.y + item.h      },
    ];

    for (const h of handles) {
        if (Math.abs(lx - h.hx) <= hitR && Math.abs(ly - h.hy) <= hitR)
            return h.name;
    }
    return null;
}

// ── Resize с ограничениями ───────────────────────────────

function _getMinSize() {
    return confState.field.step * 2;
}

function _applyResize(item, type, handle, wx, wy) {
    if (type === 'zone' && confState.fixedZoneSize.enabled) return;

    const nx = snap(wx);
    const ny = snap(wy);

    let newX = item.x, newY = item.y;
    let newW = item.w, newH = item.h;

    let MIN_SIZE = _getMinSize();

    // Горизонталь
    if (handle === 'tl' || handle === 'ml' || handle === 'bl') {
        newW = item.x + item.w - nx;
        newX = nx;
    } else if (handle === 'tr' || handle === 'mr' || handle === 'br') {
        newW = nx - item.x;
    }

    // Вертикаль
    if (handle === 'tl' || handle === 'mt' || handle === 'tr') {
        newH = item.y + item.h - ny;
        newY = ny;
    } else if (handle === 'bl' || handle === 'mb' || handle === 'br') {
        newH = ny - item.y;
    }

    // Минимальный размер
    if (newW < MIN_SIZE) {
        if (handle === 'tl' || handle === 'ml' || handle === 'bl')
            newX = item.x + item.w - MIN_SIZE;
        newW = MIN_SIZE;
    }
    if (newH < MIN_SIZE) {
        if (handle === 'tl' || handle === 'mt' || handle === 'tr')
            newY = item.y + item.h - MIN_SIZE;
        newH = MIN_SIZE;
    }

    // Ограничения по типу
    if (type === 'camera') {
        const f = confState.field;
        if (newX < 0) { newW += newX; newX = 0; }
        if (newY < 0) { newH += newY; newY = 0; }
        if (newX + newW > f.w) newW = f.w - newX;
        if (newY + newH > f.h) newH = f.h - newY;
    } else if (type === 'zone') {
        const cam = confState.cameras.find(c => c.id === item.cameraId);
        if (cam) {
            if (newX < cam.x) { newW -= cam.x - newX; newX = cam.x; }
            if (newY < cam.y) { newH -= cam.y - newY; newY = cam.y; }
            if (newX + newW > cam.x + cam.w) newW = cam.x + cam.w - newX;
            if (newY + newH > cam.y + cam.h) newH = cam.y + cam.h - newY;
        }
    } else if (type === 'image') {
        const f = confState.field;
        if (newX < 0) { newW += newX; newX = 0; }
        if (newY < 0) { newH += newY; newY = 0; }
        if (newX + newW > f.w) newW = f.w - newX;
        if (newY + newH > f.h) newH = f.h - newY;
    }

    // Финальная проверка минимума после clamp
    if (newW < MIN_SIZE) newW = MIN_SIZE;
    if (newH < MIN_SIZE) newH = MIN_SIZE;

    item.x = newX;
    item.y = newY;
    item.w = newW;
    item.h = newH;

    // После ресайза камеры — пережать зоны
    if (type === 'camera') {
        confState.zones.forEach(zone => {
            if (zone.cameraId === item.id) clampZoneToCamera(zone);
        });
    }
}

// ── Pointer events ───────────────────────────────────────

let _panStart = null;

function _onDown(e) {
    const canvas = e.currentTarget;

    // Pan
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        _panStart = { x: e.clientX - confState.view.ox, y: e.clientY - confState.view.oy };
        canvas.setPointerCapture(e.pointerId);
        return;
    }

    if (e.button !== 0) return;

    const w = canvasToWorld(e.clientX, e.clientY);

    // 1. Handle у текущего выделенного
    if (confState.selected) {
        const selItem = _getList(confState.selected.type)
            .find(i => i.id === confState.selected.id);
        if (selItem) {
            const handle = _hitHandle(selItem, w.x, w.y);
            if (handle === 'rotate') {
                confState.rotating = {
                    id:   confState.selected.id,
                    type: confState.selected.type,
                };
                canvas.setPointerCapture(e.pointerId);
                confDraw();
                return;
            }
            if (handle) {
                confState.resize = {
                    id:     confState.selected.id,
                    type:   confState.selected.type,
                    handle,
                };
                canvas.setPointerCapture(e.pointerId);
                confDraw();
                return;
            }
        }
    }

    // 2. Hit test элементов
    const hit = _hitTest(w.x, w.y);

    if (hit) {
        confState.selected = hit;
        const item = _getList(hit.type).find(i => i.id === hit.id);
        if (item) {
            confState.dragging = {
                id:      hit.id,
                type:    hit.type,
                offsetX: w.x - item.x,
                offsetY: w.y - item.y,
            };
        }
        canvas.setPointerCapture(e.pointerId);
    } else {
        confState.selected = null;
    }

    confDraw();
    renderAllLists();
}

function _onMove(e) {
    const w = canvasToWorld(e.clientX, e.clientY);

    document.getElementById('confCursorPos').textContent =
        `X: ${Math.round(w.x)} Y: ${Math.round(w.y)}`;

    // Pan
    if (_panStart) {
        confState.view.ox = e.clientX - _panStart.x;
        confState.view.oy = e.clientY - _panStart.y;
        confDraw();
        return;
    }

    // Resize
    if (confState.rotating) {
        const r    = confState.rotating;
        const item = _getList(r.type).find(i => i.id === r.id);
        if (item) {
            const cx = item.x + item.w / 2;
            const cy = item.y + item.h / 2;
            let angle = Math.atan2(w.x - cx, -(w.y - cy)) * 180 / Math.PI;

            // Shift — шаг 90°
            if (e.shiftKey) {
                angle = Math.round(angle / 90) * 90;
            }

            item.rotation = ((Math.round(angle) % 360) + 360) % 360;
            confDraw();
        }
        return;
    }

    if (confState.resize) {
        const r    = confState.resize;
        const item = _getList(r.type).find(i => i.id === r.id);
        if (item) {
            _applyResize(item, r.type, r.handle, w.x, w.y);
            confDraw();
        }
        return;
    }

    // Drag
    const d = confState.dragging;
    if (!d) return;

    const item = _getList(d.type).find(i => i.id === d.id);
    if (!item) return;

    let nx = snap(w.x - d.offsetX);
    let ny = snap(w.y - d.offsetY);

    if (d.type === 'camera') {
        const oldX = item.x, oldY = item.y;
        const clamped = clampToField(nx, ny, item.w, item.h);
        item.x = clamped.x;
        item.y = clamped.y;

        const dx = item.x - oldX;
        const dy = item.y - oldY;
        confState.zones.forEach(zone => {
            if (zone.cameraId !== item.id) return;
            zone.x += dx;
            zone.y += dy;
            clampZoneToCamera(zone);
        });
    } else if (d.type === 'zone') {
        item.x = nx;
        item.y = ny;
        clampZoneToCamera(item);
    } else {
        const clamped = clampToField(nx, ny, item.w, item.h);
        item.x = clamped.x;
        item.y = clamped.y;
    }

    confDraw();
}

function _onUp(e) {
    _panStart          = null;
    confState.dragging = null;
    confState.resize   = null;
    confState.rotating = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
}

function _onWheel(e) {
    e.preventDefault();
    const v    = confState.view;
    const rect = document.getElementById('confCanvas').getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    const prev   = v.scale;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    v.scale = Math.min(20, Math.max(0.1, prev * factor));

    const ratio = v.scale / prev;
    v.ox = mx - (mx - v.ox) * ratio;
    v.oy = my - (my - v.oy) * ratio;

    confDraw();
}

function _onKey(e) {
    const page = document.getElementById('page-4');
    if (!page || page.style.display === 'none') return;

    if (e.key === 'Delete' && confState.selected) {
        const { type, id } = confState.selected;
        const list = _getList(type);
        const idx  = list.findIndex(i => i.id === id);
        if (idx !== -1) list.splice(idx, 1);
        if (type === 'camera') {
            confState.zones = confState.zones.filter(z => z.cameraId !== id);
        }
        confState.selected = null;
        confDraw();
        renderAllLists();
    }

    if ((e.key === 'r' || e.key === 'к') && confState.selected?.type === 'zone') {
        const zone = confState.zones.find(z => z.id === confState.selected.id);
        if (zone) {
            zone.rotation = (zone.rotation + 90) % 360;
            confDraw();
        }
    }

    if ((e.key === 'c' || e.key === 'с') && confState.selected?.type === 'image') {
        if (confState.dragging && confState.dragging.type === 'image') {
            confState.dragging = null;
        }

        const img = confState.images.find(i => i.id === confState.selected.id);
        if (img) {
            const f = confState.field;
            img.x = snap((f.w - img.w) / 2);
            img.y = snap((f.h - img.h) / 2);
            confDraw();
        }
    }
}