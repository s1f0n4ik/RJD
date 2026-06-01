/**
 * birdview/calibration.js — Паттерн, снимки, процесс калибровки, overlay
 */
'use strict';

import { state } from '../core/state.js';
import { sendWS } from '../core/websocket.js';
import { log, showToast } from '../utils/utility.js';
import {
    setCalibrationState, setUndistortionState,
    showPanelBlock, enableSaveButton,
} from '../ui/status.js';
import {
    requestDistortionCompute, setSliderConfig, syncSlider,
    showDistortionControls, hideDistortionControls,
} from './distortion.js';

// ── DOM ──────────────────────────────────────────────────────
const dom = {
    patternWidth:    document.getElementById('patternWidth'),
    patternHeight:   document.getElementById('patternHeight'),
    patternSize:     document.getElementById('patternSize'),
    patternDetails:  document.getElementById('patternDetails'),
    snapshotCount:   document.getElementById('snapshotCount'),
    snapshotList:    document.getElementById('snapshotList'),
    checkChessboard: document.getElementById('chessboardToggle'),
};

const _cal = {
    overlay:       () => document.getElementById('calOverlay'),
    spinner:       () => document.getElementById('calSpinner'),
    indeterminate: () => document.getElementById('calIndeterminate'),
    resultIcon:    () => document.getElementById('calResultIcon'),
    stepLabel:     () => document.getElementById('calStepLabel'),
    stepDesc:      () => document.getElementById('calStepDesc'),
    resultTitle:   () => document.getElementById('calResultTitle'),
    resultDesc:    () => document.getElementById('calResultDesc'),
    progressWrap:  () => document.getElementById('calProgressWrap'),
    progressFill:  () => document.getElementById('calProgressFill'),
    stepCounter:   () => document.getElementById('calStepCounter'),
    itemCounter:   () => document.getElementById('calItemCounter'),
    dismissBtn:    () => document.getElementById('calDismissBtn'),
    video:         () => document.getElementById('remoteVideo'),
    noSignal:      () => document.getElementById('noSignal'),
};

// ════════════════════════════════════════════════════════════
// ПАТТЕРН
// ════════════════════════════════════════════════════════════

export function savePattern() {
    sendWS({
        type: 'calibrate_pattern', client_id: state.clientId,
        meta: {
            width: parseInt(dom.patternWidth.value),
            height: parseInt(dom.patternHeight.value),
            size: parseFloat(dom.patternSize.value),
        },
    });
}

export function handleGetCalibrationPattern(msg) {
    if (!msg.ret) { log(`Паттерн: ${msg.meta?.description ?? ''}`, 'err'); setCalibrationState('none'); return; }
    dom.patternWidth.textContent = msg.meta?.width ?? null;
    dom.patternHeight.textContent = msg.meta?.height ?? null;
    dom.patternSize.textContent = msg.meta?.size ?? null;
    setCalibrationState('installed');
    dom.patternDetails.setAttribute('data-set', '');
    dom.patternDetails.open = false;
}

// ════════════════════════════════════════════════════════════
// ШАХМАТКА
// ════════════════════════════════════════════════════════════

export function onChessboardClick(event) {
    event.preventDefault();
    const desired = !dom.checkChessboard.checked;
    sendWS({ type: 'chessboard', client_id: state.clientId, meta: { show: !desired } });
}

export function handleChessboardResponse(msg) {
    if (!msg.ret) { log(`Шахматка: ${msg.meta?.description ?? ''}`, 'err'); return; }
    dom.checkChessboard.checked = msg.meta?.show ?? false;
}

// ════════════════════════════════════════════════════════════
// СНИМКИ
// ════════════════════════════════════════════════════════════

export function takeSnapshot() {
    sendWS({ type: 'add_image', client_id: state.clientId, meta: {} });
    log('Запрос снимка', 'ok');
}

export function handleAddImageResponse(msg) {
    if (!msg.ret) { log(`Снимок: ${msg.meta?.description ?? ''}`, 'err'); return; }
    const count = msg.meta?.count ?? 0;
    const added_id = msg.meta?.added_id ?? -1;
    dom.snapshotCount.textContent = count;
    dom.snapshotList.appendChild(_createItem(added_id));
    log(`Снимок id=${added_id}. Всего: ${count}`, 'ok');
}

export function requestRemoveSnapshot(id) {
    sendWS({ type: 'delete_image', client_id: state.clientId, meta: { id, all: false } });
}

export function requestClearSnapshotList() {
    sendWS({ type: 'delete_image', client_id: state.clientId, meta: { id: -1, all: true } });
}

export function clearSnapshotList() {
    dom.snapshotList.innerHTML = '';
    dom.snapshotCount.textContent = '0';
}

export function handleRemoveSnapshot(msg) {
    if (!msg.ret) { log(`Удаление: ${msg.meta?.description ?? ''}`, 'err'); return; }
    const { id = -1, all = false, count: size = -1 } = msg.meta ?? {};
    if (all) { clearSnapshotList(); log('Все снимки очищены', 'ok'); return; }
    if (id === -1 || size === -1) { log(`Некорректные данные`, 'err'); return; }
    document.querySelector(`.snapshot-item[data-id="${id}"]`)?.remove();
    document.querySelectorAll('.snapshot-item').forEach((item, i) => {
        item.dataset.id = i;
        item.querySelector('.snapshot-item-id').textContent = `# ${String(i).padStart(3, '0')}`;
    });
    dom.snapshotCount.textContent = `${size}`;
}

function _createItem(id) {
    const item = document.createElement('div');
    item.className = 'snapshot-item';
    item.dataset.id = id;
    item.innerHTML = `
        <span class="snapshot-item-id"># ${String(id).padStart(3, '0')}</span>
        <span class="snapshot-used" title="не использован"></span>
        <button class="btn-icon" title="Удалить">✕</button>
    `;
    return item;
}

export function requestSnapshotFrame(id) {
    sendWS({ type: 'get_image', client_id: state.clientId, meta: { id } });
}

export function handleSnapshotFrame(msg) {
    if (!msg.ret) { log(`Кадр: ${msg.meta?.description}`, 'err'); return; }
    _showFrame(msg.meta?.id ?? '?', msg._imageBytes);
}

export function setSnapshotUsed(id, used) {
    const dot = document.querySelector(`.snapshot-item[data-id="${id}"] .snapshot-used`);
    if (!dot) return;
    dot.classList.toggle('used', used);
    dot.title = used ? 'использован' : 'не использован';
}

export function toggleSnapshotDrawer() {
    document.getElementById('snapshotDrawer')?.classList.toggle('open');
}

function _showFrame(id, bytes) {
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const wrapper = document.getElementById('videoWrapper');
    const video = document.getElementById('remoteVideo');
    video.style.display = 'none';

    let img = document.getElementById('snapshotFrameImg');
    if (!img) {
        img = document.createElement('img');
        img.id = 'snapshotFrameImg';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;position:relative;z-index:1;';
        wrapper.appendChild(img);
    }
    if (img._prevUrl) URL.revokeObjectURL(img._prevUrl);
    img.src = url;
    img._prevUrl = url;

    document.getElementById('snapshotIndicator')?.classList.remove('hidden');
    const idEl = document.getElementById('snapshotIndicatorId');
    if (idEl) idEl.textContent = `snapshot # ${String(id).padStart(3, '0')}`;
    const btn = document.getElementById('resumeStreamBtn');
    if (btn) btn.disabled = false;
}

export function resumeStream() {
    document.getElementById('remoteVideo').style.display = 'block';
    const img = document.getElementById('snapshotFrameImg');
    if (img) { if (img._prevUrl) URL.revokeObjectURL(img._prevUrl); img.remove(); }
    document.getElementById('snapshotIndicator')?.classList.add('hidden');
    const btn = document.getElementById('resumeStreamBtn');
    if (btn) btn.disabled = true;
}

// ── Клик по snapshot-list ────────────────────────────────────
dom.snapshotList?.addEventListener('click', (e) => {
    const item = e.target.closest('.snapshot-item');
    if (!item) return;
    e.target.closest('.btn-icon')
        ? requestRemoveSnapshot(+item.dataset.id)
        : requestSnapshotFrame(+item.dataset.id);
});

// ════════════════════════════════════════════════════════════
// СТАТУС КАЛИБРОВКИ
// ════════════════════════════════════════════════════════════

export function handleCalibrationStatus(msg) {
    if (!msg.ret) { log(`Статус: ${msg.meta?.description ?? ''}`, 'err'); return; }
    const meta = msg.meta ?? {};

    if (meta.width != null) setSliderConfig('shift_x', { value: 0, min: -meta.width, max: meta.width, decimals: 0 });
    if (meta.height != null) setSliderConfig('shift_y', { value: 0, min: -meta.height, max: meta.height, decimals: 0 });

    if (meta.is_pattern) {
        dom.patternDetails.setAttribute('data-set', '');
        dom.patternDetails.removeAttribute('open');
        if (meta.pattern_width !== undefined) dom.patternWidth.textContent = meta.pattern_width;
        if (meta.pattern_height !== undefined) dom.patternHeight.textContent = meta.pattern_height;
        if (meta.pattern_size !== undefined) dom.patternSize.textContent = meta.pattern_size;
    } else {
        dom.patternDetails.removeAttribute('data-set');
        dom.patternDetails.open = true;
    }

    const hasCal = meta.is_calibration ?? false;
    setCalibrationState(hasCal ? 'installed' : 'none');

    if (hasCal) {
        for (const k of ['alpha', 'zoom', 'shift_x', 'shift_y', 'k1', 'k2', 'k3', 'k4'])
            if (meta[k] !== undefined) syncSlider(k, Number(meta[k]));
        showPanelBlock('correctionBlock');
        showDistortionControls();
    } else {
        hideDistortionControls();
    }

    const hasUndist = meta.is_undistortion ?? false;
    if (hasUndist) enableSaveButton();
    setUndistortionState(hasUndist ? 'success' : 'failed');

    if (dom.checkChessboard) dom.checkChessboard.checked = meta?.show_chessboard ?? false;
    const distToggle = document.getElementById('distortionDisplayToggle');
    if (distToggle) distToggle.checked = meta?.show_undistortion ?? false;
}

// ════════════════════════════════════════════════════════════
// ПРОЦЕСС КАЛИБРОВКИ
// ════════════════════════════════════════════════════════════

export function calibrateStart() {
    sendWS({ type: 'calibration_start', client_id: state.clientId, meta: {} });
}

export function handleStartCalibration(msg) {
    if (!msg.ret) {
        log(`Ошибка: ${msg.meta?.description ?? ''}`, 'err');
        showToast('Ошибка калибровки', msg.meta?.description ?? '', 'err');
        return;
    }
    const total = msg.meta?.total ?? 0;
    calShowStep({ label: 'Обработка снимков', desc: 'Обнаружение шахматной доски', step: 1, totalSteps: total, progress: 0 });
}

export function handleCalibrateStep(msg) {
    if (!msg.ret) { log(`Шаг: ${msg.meta?.description ?? ''}`, 'err'); return; }
    const { id, current_count = 0, total = 0, corners_found = false } = msg.meta ?? {};
    calUpdateProgress({ step: current_count, totalSteps: total, progress: current_count / total * 100, itemCurrent: current_count, itemTotal: total });
    setSnapshotUsed(id, corners_found);
}

export function handleReprojectionError(msg) {
    if (!msg.ret) return;
    setSnapshotUsed(msg.meta?.id ?? -1, msg.meta?.corners_found ?? false);
}

export function handleCalibrationCompute(msg) {
    if (!msg.ret) return;
    calShowIndeterminate({ label: 'Вычисление', desc: 'Вычисление матрицы коррекции...' });
}

export function handleCalibrationResult(msg) {
    if (!msg.ret) {
        calShowError({ title: 'Ошибка калибровки', desc: msg.meta?.description ?? '' });
    }
    const { width = -1, height = -1, rms = -1, used_images = -1, total = -1 } = msg.meta ?? {};

    if (rms > 1.0) {
        calShowError({ title: 'Калибровка завершена', desc: `Погрешность: ${rms}px — слишком высокая!\nОбработано: ${total}, использовано ${used_images}` });
    } else {
        calShowSuccess({ title: 'Калибровка завершена', desc: `Погрешность: ${rms}px\nОбработано: ${total}, использовано ${used_images}` });
    }

    setSliderConfig('alpha', { value: 0, min: 0, max: 1, decimals: 2 });
    setSliderConfig('zoom', { value: 1, min: 0.1, max: 2.0, mid: 1.0, decimals: 2 });
    setSliderConfig('shift_x', { value: 0, min: -width, max: width, decimals: 0 });
    setSliderConfig('shift_y', { value: 0, min: -height, max: height, decimals: 0 });
    requestDistortionCompute(false);
}

// ════════════════════════════════════════════════════════════
// OVERLAY
// ════════════════════════════════════════════════════════════

function _calReset() {
    _cal.spinner().style.display = 'block';
    _cal.indeterminate().style.display = 'none';
    _cal.resultIcon().style.display = 'none';
    _cal.stepLabel().style.display = 'none';
    _cal.stepDesc().style.display = 'none';
    _cal.resultTitle().style.display = 'none';
    _cal.resultDesc().style.display = 'none';
    _cal.progressWrap().style.display = 'none';
    _cal.dismissBtn().style.display = 'none';
    _cal.resultIcon().className = 'cal-result-icon';
    _cal.resultTitle().className = 'cal-result-title';
}

function calShow() {
    _cal.video()?.classList.remove('active');
    _cal.noSignal()?.classList.add('hidden');
    _calReset();
    _cal.overlay().style.display = 'flex';
}

export function calHide() {
    _cal.overlay().style.display = 'none';
    if (_cal.video()?.srcObject) { _cal.video().classList.add('active'); _cal.noSignal()?.classList.add('hidden'); }
    else { _cal.noSignal()?.classList.remove('hidden'); }
}

function calShowStep({ label, desc = '', step = null, totalSteps = null, progress = null } = {}) {
    calShow();
    _cal.spinner().style.display = 'block';
    _cal.indeterminate().style.display = 'none';
    _cal.stepLabel().textContent = label;
    _cal.stepLabel().style.display = 'block';
    if (desc) { _cal.stepDesc().textContent = desc; _cal.stepDesc().style.display = 'block'; }
    if (progress !== null) {
        _cal.progressFill().style.width = Math.min(100, Math.max(0, progress)) + '%';
        _cal.stepCounter().textContent = (step != null && totalSteps != null) ? `Шаг ${step} / ${totalSteps}` : '';
        _cal.itemCounter().textContent = `${Math.round(progress)}%`;
        _cal.progressWrap().style.display = 'block';
    }
}

function calUpdateProgress({ step, totalSteps, progress, itemCurrent, itemTotal } = {}) {
    if (progress != null) _cal.progressFill().style.width = Math.min(100, Math.max(0, progress)) + '%';
    if (step && totalSteps) _cal.stepCounter().textContent = `Шаг ${step} / ${totalSteps}`;
    if (itemCurrent !== undefined && itemTotal !== undefined) _cal.itemCounter().textContent = `${itemCurrent} / ${itemTotal}`;
    else if (progress != null) _cal.itemCounter().textContent = `${Math.round(progress)}%`;
}

function calShowIndeterminate({ label, desc = '' } = {}) {
    calShow();
    _cal.spinner().style.display = 'none';
    _cal.indeterminate().style.display = 'block';
    _cal.stepLabel().textContent = label;
    _cal.stepLabel().style.display = 'block';
    if (desc) { _cal.stepDesc().textContent = desc; _cal.stepDesc().style.display = 'block'; }
}

function calShowSuccess({ title = 'Калибровка завершена', desc = '' } = {}) {
    _calReset(); _cal.overlay().style.display = 'flex'; _cal.spinner().style.display = 'none';
    _cal.resultIcon().classList.add('ok'); _cal.resultIcon().textContent = '✓'; _cal.resultIcon().style.display = 'flex';
    _cal.resultTitle().textContent = title; _cal.resultTitle().classList.add('ok'); _cal.resultTitle().style.display = 'block';
    if (desc) { _cal.resultDesc().textContent = desc; _cal.resultDesc().style.display = 'block'; }
    _cal.dismissBtn().textContent = 'Готово'; _cal.dismissBtn().className = 'btn btn-accent'; _cal.dismissBtn().style.display = 'block';
}

function calShowError({ title = 'Ошибка', desc = '' } = {}) {
    _calReset(); _cal.overlay().style.display = 'flex'; _cal.spinner().style.display = 'none';
    _cal.resultIcon().classList.add('err'); _cal.resultIcon().textContent = '✕'; _cal.resultIcon().style.display = 'flex';
    _cal.resultTitle().textContent = title; _cal.resultTitle().classList.add('err'); _cal.resultTitle().style.display = 'block';
    if (desc) { _cal.resultDesc().textContent = desc; _cal.resultDesc().style.display = 'block'; }
    _cal.dismissBtn().textContent = 'Закрыть'; _cal.dismissBtn().className = 'btn btn-ghost'; _cal.dismissBtn().style.display = 'block';
}