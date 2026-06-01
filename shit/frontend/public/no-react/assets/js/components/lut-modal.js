/**
 * projection/lut-modal.js — Модалка сохранения LUT
 */
'use strict';

import { log, showToast } from '../utils/utility.js';
import { projState } from '../core/projection-consts.js';

// ── Ссылка на серверную функцию (устанавливается из index.js) ─
let _requestSaveLut = () => {};
export function setRequestSaveLut(fn) { _requestSaveLut = fn; }

const LUT_ID_RE = /^[a-z][a-z0-9_]*$/;

// ════════════════════════════════════════════════════════════
// Открытие / закрытие
// ════════════════════════════════════════════════════════════

export function projCalculateLUT() {
    const cams    = projState.activePreset?.cameras ?? [];
    const allDone = cams.length > 0 && cams.every(c => projState.doneSet.has(c.key));
    if (!allDone) {
        showToast('Нельзя сохранить', 'Не все камеры применены', 'err');
        return;
    }
    _openModal();
}

function _openModal() {
    const backdrop = document.getElementById('lutSaveModalBackdrop');
    backdrop?.classList.remove('hidden');

    const idInput   = document.getElementById('lutSaveId');
    const nameInput = document.getElementById('lutSaveName');
    if (idInput) idInput.value = _generateId();
    if (nameInput) nameInput.value = '';
    _validateId();

    if (idInput)   idInput.oninput   = _validateId;
    if (nameInput) nameInput.oninput = _validateSubmit;

    setTimeout(() => idInput?.focus(), 30);
}

export function closeLutSaveModal(e) {
    if (e && e.target.id !== 'lutSaveModalBackdrop') return;
    document.getElementById('lutSaveModalBackdrop')?.classList.add('hidden');
}

// ════════════════════════════════════════════════════════════
// Генерация ID
// ════════════════════════════════════════════════════════════

function _generateId() {
    const presetName = projState.activePreset?.name ?? 'config';
    const base = presetName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^[0-9]+/, '') || 'config';

    const suffix = Date.now().toString(36).slice(-5);
    return `${base}_${suffix}`;
}

// ════════════════════════════════════════════════════════════
// Валидация
// ════════════════════════════════════════════════════════════

function _validateId() {
    const input = document.getElementById('lutSaveId');
    const hint  = document.getElementById('lutSaveIdHint');
    const val   = input?.value.trim() ?? '';

    let ok = true;
    if (!val) {
        if (hint) { hint.textContent = 'ID не может быть пустым'; hint.classList.add('err'); }
        ok = false;
    } else if (!LUT_ID_RE.test(val)) {
        if (hint) { hint.textContent = 'Только латиница, цифры и _, начинается с буквы'; hint.classList.add('err'); }
        ok = false;
    } else {
        if (hint) { hint.textContent = 'Только латиница, цифры и _'; hint.classList.remove('err'); }
    }

    input?.classList.toggle('invalid', !ok);
    _validateSubmit();
    return ok;
}

function _validateSubmit() {
    const idOk   = LUT_ID_RE.test(document.getElementById('lutSaveId')?.value.trim() ?? '');
    const nameOk = (document.getElementById('lutSaveName')?.value.trim().length ?? 0) > 0;
    const btn    = document.getElementById('lutSaveConfirmBtn');
    if (btn) btn.disabled = !(idOk && nameOk);
}

// ════════════════════════════════════════════════════════════
// Отправка
// ════════════════════════════════════════════════════════════

export function submitLutSave() {
    if (!_validateId()) return;

    const id   = document.getElementById('lutSaveId')?.value.trim();
    const name = document.getElementById('lutSaveName')?.value.trim();
    if (!id || !name) return;

    const btn = document.getElementById('lutSaveConfirmBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...'; }

    _requestSaveLut(id, name);
    log(`save_lut sent: id=${id} name="${name}"`, 'info');
}