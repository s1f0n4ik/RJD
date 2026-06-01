/**
 * birdview/config.js — Загрузка / сохранение конфигураций калибровки
 */
'use strict';

import { state } from '../core/state.js';
import { sendWS } from '../core/websocket.js';
import { log, showToast } from '../utils/utility.js';

const modal  = document.getElementById('loadConfigModal');
const list   = document.getElementById('configList');
const detail = document.getElementById('configDetail');

let _selectedConfigId = null;

const CONFIG_FIELDS = [
    { key: 'id',              label: 'Идентификатор' },
    { key: 'width',           label: 'Ширина' },
    { key: 'height',          label: 'Высота' },
    { key: 'is_pattern',      label: 'Паттерн задан' },
    { key: 'pattern_size',    label: 'Размер ячейки (мм)' },
    { key: 'pattern_width',   label: 'Ширина паттерна' },
    { key: 'pattern_height',  label: 'Высота паттерна' },
    { key: 'is_calibration',  label: 'Калибровка проведена' },
    { key: 'rms',             label: 'RMS' },
    { key: 'alpha',           label: 'Alpha' },
    { key: 'zoom',            label: 'Приближение' },
    { key: 'shift_x',         label: 'Смещение X' },
    { key: 'shift_y',         label: 'Смещение Y' },
    { key: 'dist_coeffs',     label: 'Коэффициенты искажений' },
    { key: 'is_undistortion', label: 'Коррекция применена' },
];

export function requestListOfCalibrationConfigurations() {
    sendWS({ type: 'calibration_configuration', client_id: state.clientId, camera: state.streamId, meta: { method: 'get_list' }, ret: 'none' });
}

export async function openLoadConfigModal(configs = []) {
    _selectedConfigId = null;
    if (detail) detail.style.display = 'none';
    if (modal) modal.style.display = 'flex';
    if (list) list.innerHTML = `<div class="custom-select-loading">Загрузка...</div>`;

    let cameraMap = {};
    try { const r = await fetch('/api/camera'); cameraMap = (await r.json())?.data?.cameras ?? {}; } catch {}

    if (!list) return;
    list.innerHTML = '';
    if (!configs.length) { list.innerHTML = `<div class="custom-select-empty">Нет конфигураций</div>`; return; }

    configs.forEach(cfg => {
        const name = cameraMap[cfg.id]?.display_name ?? cfg.id;
        const item = document.createElement('div');
        item.className = 'config-list-item';
        item.innerHTML = `<span class="config-item-name">${name}</span><span class="config-item-sub">${cfg.id} · ${cfg.width ?? '—'}×${cfg.height ?? '—'}</span>`;
        item.onclick = () => _select(cfg, item);
        list.appendChild(item);
    });
}

export function closeLoadConfigModal(e) {
    if (e && e.target !== modal) return;
    if (modal) modal.style.display = 'none';
}

function _select(cfg, el) {
    document.querySelectorAll('.config-list-item').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    _selectedConfigId = cfg.config_key ?? cfg.id ?? null;
    const tbody = document.getElementById('configTableBody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="2" style="text-align:center;padding:24px"><span class="custom-select-loading">Загрузка...</span></td></tr>`;
    if (detail) detail.style.display = 'flex';
    sendWS({ type: 'calibration_configuration', client_id: state.clientId, camera: state.streamId, meta: { method: 'get_item', config_key: _selectedConfigId }, ret: 'none' });
}

function _renderDetail(data) {
    const tbody = document.getElementById('configTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!data || typeof data !== 'object') { tbody.innerHTML = `<tr><td colspan="2" style="text-align:center;color:var(--err)">Нет данных</td></tr>`; return; }
    CONFIG_FIELDS.forEach(({ key, label }) => {
        if (!(key in data)) return;
        const { text, cls } = _fmt(key, data[key]);
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${label}</td><td class="${cls}">${text}</td>`;
        tbody.appendChild(tr);
    });
}

function _fmt(key, val) {
    if (val == null) return { text: '—', cls: '' };
    if (['is_pattern', 'is_calibration', 'is_undistortion'].includes(key)) return val ? { text: 'Да', cls: 'cv-ok' } : { text: 'Нет', cls: 'cv-err' };
    if (key === 'rms') { const n = parseFloat(val); return { text: `${n.toFixed(3)} px`, cls: n < 0.5 ? 'cv-ok' : n < 1.5 ? 'cv-warn' : 'cv-err' }; }
    if (key === 'dist_coeffs') return { text: typeof val === 'object' && 'rows' in val ? `${val.rows}×${val.cols} mat` : 'Получена', cls: 'cv-ok' };
    if (['alpha', 'zoom', 'shift_x', 'shift_y'].includes(key)) return { text: parseFloat(val).toFixed(3), cls: '' };
    return { text: String(val), cls: '' };
}

export function requestLoadSelectedConfig() {
    if (!_selectedConfigId) { log('Нет выбранного конфига', 'warn'); return; }
    sendWS({ type: 'calibration_configuration', client_id: state.clientId, camera: state.streamId, meta: { method: 'load', config_key: _selectedConfigId }, ret: 'none' });
}

export function saveCalibrationConfiguration() {
    sendWS({ type: 'calibration_configuration', client_id: state.clientId, camera: state.streamId, meta: { method: 'save' }, ret: 'none' });
}

export function handleCalibrationConfiguration(msg) {
    if (!msg.meta) { showToast('Ошибка', 'Нет meta', 'err'); return; }
    switch (msg.meta.method) {
        case 'save':
            msg.ret ? showToast('Сохранено', '', 'ok') : showToast('Ошибка', msg.meta?.description ?? '', 'err');
            break;
        case 'get_list':
            if (!msg.ret) { showToast('Ошибка', msg.meta?.description ?? '', 'err'); return; }
            openLoadConfigModal(msg.meta?.configs ?? []);
            break;
        case 'get_item':
            _renderDetail(msg.meta?.config_item ?? {});
            break;
        case 'load':
            if (!msg.ret) { showToast('Ошибка', msg.meta?.description ?? '', 'err'); }
            else { showToast('Загружено', _selectedConfigId, 'ok'); closeLoadConfigModal(); }
            break;
        default: log(`Неизвестный метод: ${msg.meta.method}`, 'warn');
    }
}