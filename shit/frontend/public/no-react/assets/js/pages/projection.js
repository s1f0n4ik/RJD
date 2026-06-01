/**
 * projection/index.js — Входная точка модуля проекции
 *
 * Собирает все подмодули, связывает их и экспортирует
 * только то, что нужно внешнему коду (app.js, linker.js).
 */
'use strict';

// ── Re-exports для внешнего кода ─────────────────────────────
export { PROJ_POSITION_LABELS } from '../core/projection-consts.js';
export { handleProjectionMessage, setSendWSMessage } from '../api/proj-server.js';
export { sendWSMessage } from '../core/websocket.js';

// ── Внутренние импорты для инициализации ─────────────────────
import { projState } from '../core/projection-consts.js';
import { initProjWarpCanvas, initWarpZoomPan, setRenderCamList, projDraw } from '../components/canvas.js';
import { renderProjCamList } from '../components/cam-list.js';
import {requestWarp, setSendWSMessage} from '../api/proj-server.js';
import { showToast } from '../utils/utility.js';
import { currentMaxPoints } from '../core/projection-consts.js';

// Подмодули, подключаемые к window
import { toggleProjSettings, toggleVehicleSelect, renderVehicleList, setServerCallbacks } from '../components/proj-settings.js';
import {
    projRemoveLastPoint, projClearPoints, projResetView,
} from '../components/canvas.js';
import {
    projResultZoom, projResultDragStart,
    projResultDragMove, projResultDragEnd,
} from '../components/proj-result.js';
import { projCalculateLUT, closeLutSaveModal, submitLutSave, setRequestSaveLut } from '../components/lut-modal.js';
import {
    requestProjectionList, requestSetProjectionConfiguration, requestSaveLut,
    setRenderVehicleList as setRVL, setCloseLutModal,
} from '../api/proj-server.js';

// ── Связки (без циклических импортов) ────────────────────────
setRenderCamList(renderProjCamList);
setSendWSMessage(sendWSMessage);
setServerCallbacks(requestProjectionList, requestSetProjectionConfiguration);
setRVL(renderVehicleList);
setRequestSaveLut(requestSaveLut);
setCloseLutModal(closeLutSaveModal);

// ════════════════════════════════════════════════════════════
// projToggleApply — связывает warp-canvas и server
// ════════════════════════════════════════════════════════════

function projToggleApply() {
    if (projState.applied) {
        projState.points  = [...projState.savedPoints];
        projState.applied = false;
        document.getElementById('projWarpWrapper')?.classList.remove('applied');
        document.getElementById('projApplyBtn').textContent   = '⊛ Применить warp';
        document.getElementById('projEditState').textContent  = 'Режим: редактирование';
        projDraw();
        return;
    }

    if (!projState.activeCam) {
        showToast('Камера не выбрана', 'Выберите камеру в настройках', 'err');
        return;
    }

    const maxPts = currentMaxPoints();
    if (projState.points.length < maxPts) {
        showToast('Недостаточно точек', `Необходимо ${maxPts} точки`, 'err');
        return;
    }

    const normPoints = projState.points.map(p => ({
        x: +p.x.toFixed(8),
        y: +p.y.toFixed(8),
    }));

    requestWarp(normPoints, projState.activeCam);
}

// ════════════════════════════════════════════════════════════
// initProjPage — вызывается при переходе на страницу 2
// ════════════════════════════════════════════════════════════

export function initProjPage() {
    const video   = document.getElementById('remoteVideo');
    const layer   = document.getElementById('uiCanvasLayer');

    if (video && layer && !layer.contains(video)) {
        layer.insertBefore(video, layer.firstChild);
        if (video.srcObject) {
            video.classList.add('active');
            document.getElementById('noSignal3')?.classList.add('hidden');
        }
    }

    initProjWarpCanvas();
    initWarpZoomPan();
    renderProjCamList();
}

// ════════════════════════════════════════════════════════════
// Global bindings (onclick из HTML)
// ════════════════════════════════════════════════════════════

Object.assign(window, {
    toggleProjSettings,
    projRemoveLastPoint,
    projClearPoints,
    projToggleApply,
    projResultZoom,
    projResultDragStart,
    projResultDragMove,
    projResultDragEnd,
    projCalculateLUT,
    toggleVehicleSelect,
    closeLutSaveModal,
    submitLutSave,
    projResetView,
});