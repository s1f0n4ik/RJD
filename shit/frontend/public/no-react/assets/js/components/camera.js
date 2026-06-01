/**
 * birdview/camera.js — Кастомный dropdown выбора камеры
 */
'use strict';

import { state } from '../core/state.js';

export function toggleCameraSelect() {
    const wrap = document.getElementById('cameraSelect');
    wrap?.classList.contains('open') ? _close() : _open();
}

function _open() {
    document.getElementById('cameraSelect')?.classList.add('open');
    _fetchList();
    setTimeout(() => document.addEventListener('click', _onOutside), 0);
}

function _close() {
    document.getElementById('cameraSelect')?.classList.remove('open');
    document.removeEventListener('click', _onOutside);
}

function _onOutside(e) {
    if (!document.getElementById('cameraSelect')?.contains(e.target)) _close();
}

async function _fetchList() {
    const list = document.getElementById('cameraSelectList');
    if (!list) return;
    list.innerHTML = `<div class="custom-select-loading">Загрузка...</div>`;

    try {
        const res  = await fetch('/api/camera');
        const json = await res.json();
        if (json.error) throw new Error(json.error);

        const cameras = json?.data?.cameras ?? {};
        const items = [];
        for (const [id, cam] of Object.entries(cameras)) {
            if (cam.type !== 3) continue;
            const sub = Object.values(cam.streams ?? {}).find(s => s.type === 1);
            if (!sub) continue;
            items.push({ id, displayName: cam.display_name, width: sub.width, height: sub.height, fps: sub.fps });
        }
        _render(items);
    } catch (err) {
        list.innerHTML = `<div class="custom-select-empty">Ошибка загрузки</div>`;
        console.error('fetchCameraList:', err);
    }
}

function _render(items) {
    const list = document.getElementById('cameraSelectList');
    list.innerHTML = '';
    if (!items.length) {
        list.innerHTML = `<div class="custom-select-empty">Нет доступных камер</div>`;
        return;
    }
    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'custom-select-item' + (state.camera?.id === item.id ? ' selected' : '');
        el.innerHTML = `<span class="custom-select-item-name">${item.displayName}</span>`;
        el.onclick = () => _select(item);
        list.appendChild(el);
    });
}

function _select(item) {
    state.camera = item;
    const label = document.getElementById('cameraSelectLabel');
    if (label) {
        label.textContent = item.displayName;
        label.classList.add('selected');
    }
    _close();
    const w = document.getElementById('width');
    const h = document.getElementById('height');
    if (w) w.value = item.width;
    if (h) h.value = item.height;
}