/**
 * projection/settings.js — Drawer настроек, выбор пресета ТС
 */
'use strict';

import { projState } from '../core/projection-consts.js';

// ── Ссылки на server-функции (устанавливаются из index.js) ───
let _requestProjectionList = () => {};
let _requestSetPreset      = () => {};

export function setServerCallbacks(list, setPreset) {
    _requestProjectionList = list;
    _requestSetPreset      = setPreset;
}

// ════════════════════════════════════════════════════════════
// Settings drawer
// ════════════════════════════════════════════════════════════

export function toggleProjSettings() {
    projState.settingsOpen = !projState.settingsOpen;
    document.getElementById('projSettingsDrawer')?.classList.toggle('open', projState.settingsOpen);
    document.getElementById('projSettingsTab')?.classList.toggle('open',    projState.settingsOpen);
    document.getElementById('projWarpArea')?.classList.toggle('shifted',    projState.settingsOpen);
}

// ════════════════════════════════════════════════════════════
// Vehicle (preset) select
// ════════════════════════════════════════════════════════════

export function toggleVehicleSelect() {
    const wrap = document.getElementById('vehicleSelect');
    wrap?.classList.contains('open') ? _close() : _open();
}

function _open() {
    document.getElementById('vehicleSelect')?.classList.add('open');
    setTimeout(() => document.addEventListener('click', _onOutside), 0);
    _requestProjectionList();
}

function _close() {
    document.getElementById('vehicleSelect')?.classList.remove('open');
    document.removeEventListener('click', _onOutside);
}

function _onOutside(e) {
    if (!document.getElementById('vehicleSelect')?.contains(e.target)) _close();
}

// ── Рендер списка пресетов ───────────────────────────────────
export function renderVehicleList() {
    const list = document.getElementById('vehicleSelectList');
    if (!list) return;
    list.innerHTML = '';

    if (!projState.presets.length) {
        list.innerHTML = `<div class="custom-select-empty">Список не получен</div>`;
        return;
    }

    projState.presets.forEach(p => {
        const el = document.createElement('div');
        const isSelected = projState.activePreset?.config_key === p.config_key;
        el.className = 'custom-select-item' + (isSelected ? ' selected' : '');
        el.innerHTML = `<span class="custom-select-item-name">${p.name ?? p.config_key}</span>`;
        el.onclick = () => _selectPreset(p);
        list.appendChild(el);
    });
}

function _selectPreset(p) {
    const label = document.getElementById('vehicleSelectLabel');
    if (label) {
        label.textContent = p.name ?? p.config_key;
        label.classList.add('selected');
    }
    _close();
    _requestSetPreset(p.config_key);
}