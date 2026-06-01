/**
 * linker/setup-ui.js — UI настройки: список экспортов, биндинги, кнопка запуска
 */
'use strict';

import { log, showToast } from '../utils/utility.js';
import { linkerState } from '../core/linker-state.js';
import { loadExportState, saveStateAndStart } from '../components/linker-data.js';

// ── Внешние зависимости (устанавливаются из index.js) ────────
let _positionLabels     = {};   // PROJ_POSITION_LABELS
let _enterStreamingView = () => {};

export function setPositionLabels(labels)      { _positionLabels = labels; }
export function setEnterStreamingView(fn)      { _enterStreamingView = fn; }

// ════════════════════════════════════════════════════════════
// Список экспортов
// ════════════════════════════════════════════════════════════

export function renderExportsList() {
    const list = document.getElementById('linkerExportsList');
    if (!list) return;
    list.innerHTML = '';

    if (!linkerState.exports.length) {
        list.innerHTML = `<div class="custom-select-empty">Нет конфигураций</div>`;
        return;
    }

    linkerState.exports.forEach(exp => {
        const isSelected = linkerState.selectedExport?.id === exp.id;
        const el = document.createElement('div');
        el.className = 'linker-list-item' + (isSelected ? ' selected' : '');
        el.innerHTML = `
            <div class="linker-list-main">
                <span class="linker-list-name">${exp.name ?? exp.id}</span>
                <span class="linker-list-id">${exp.id}</span>
            </div>
        `;
        el.onclick = () => _selectExport(exp);
        list.appendChild(el);
    });
}

async function _selectExport(exp) {
    linkerState.selectedExport = exp;
    linkerState.bindings = await loadExportState(exp.id);

    renderExportsList();
    renderBindings();
    updateApplyButton();
}

// ════════════════════════════════════════════════════════════
// Биндинги (key → camera_id)
// ════════════════════════════════════════════════════════════

export function renderBindings() {
    const section = document.getElementById('linkerBindingsSection');
    const list    = document.getElementById('linkerBindings');
    if (!list) return;
    list.innerHTML = '';

    const exp = linkerState.selectedExport;
    if (!exp || !exp.cameras?.length) {
        section?.classList.add('hidden');
        return;
    }
    section?.classList.remove('hidden');

    exp.cameras.forEach(key => {
        const currentId = linkerState.bindings[key];
        const label     = _positionLabels[key] ?? key;

        const el = document.createElement('div');
        el.className = 'linker-list-item' + (currentId ? ' selected' : '');
        el.innerHTML = `
            <div class="linker-list-main">
                <span class="linker-list-name">${label}</span>
                <span class="linker-list-id">${key}</span>
            </div>
            <select class="linker-binding-select" data-key="${key}">
                <option value="">— не привязана —</option>
                ${linkerState.cameras.map(c =>
            `<option value="${c.id}" ${c.id === currentId ? 'selected' : ''}>
                        ${c.display_name} [${c.id}]
                    </option>`
        ).join('')}
            </select>
        `;

        const sel = el.querySelector('select');
        sel.onchange = () => {
            const v = sel.value;
            if (v) linkerState.bindings[key] = v;
            else   delete linkerState.bindings[key];
            el.classList.toggle('selected', !!v);
            updateApplyButton();
        };
        el.onclick = (e) => {
            if (e.target === sel || sel.contains(e.target)) return;
            sel.focus();
            sel.click();
        };
        list.appendChild(el);
    });
}

// ════════════════════════════════════════════════════════════
// Кнопка «Применить и запустить»
// ════════════════════════════════════════════════════════════

export function updateApplyButton() {
    const btn = document.getElementById('linkerApplyBtn');
    if (btn) btn.disabled = !linkerState.selectedExport;
}

export async function applyAndStart() {
    const exp = linkerState.selectedExport;
    if (!exp) return;

    const btn = document.getElementById('linkerApplyBtn');
    if (!btn) return;

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = 'Запуск...';

    try {
        await saveStateAndStart(exp.id, linkerState.bindings);
        showToast('Запущено', 'Линкер работает', 'ok');
        _enterStreamingView();
    } catch (e) {
        log(`Linker: start failed: ${e.message}`, 'err');
        showToast('Ошибка запуска', e.message, 'err');
        btn.disabled    = false;
        btn.textContent = oldText;
    }
}