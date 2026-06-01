/**
 * linker/index.js — Входная точка модуля линкера
 *
 * Собирает подмодули, связывает колбэки, экспортирует для birdview/app.js.
 */
'use strict';

import { PROJ_POSITION_LABELS } from '../core/projection-consts.js';

import { loadExports, loadCameras, loadStatus } from '../components/linker-data.js';
import {
    renderExportsList, updateApplyButton, applyAndStart,
    setPositionLabels, setEnterStreamingView,
} from '../ui/linker-ui.js';
import {
    enterStreamingView, renderResumeButton,
    stopStream, resumeStream,
    setGetClientId,
} from '../components/linker-stream.js';

// ── Внешняя зависимость: clientId (устанавливается из birdview/app.js) ─
let _clientId = 'unknown';

export function setLinkerClientId(id) {
    _clientId = id;
    setGetClientId(() => _clientId);
}

// ── Связки (без циклических импортов) ────────────────────────
setPositionLabels(PROJ_POSITION_LABELS);
setEnterStreamingView(enterStreamingView);

// ════════════════════════════════════════════════════════════
// Инициализация страницы
// ════════════════════════════════════════════════════════════

export async function initLinkerPage() {
    document.getElementById('linkerStreamBlock')?.classList.add('hidden');
    document.getElementById('linkerSetupBlock')?.classList.remove('hidden');

    await Promise.all([loadExports(), loadCameras(), loadStatus()]);

    renderExportsList();
    renderResumeButton();
    updateApplyButton();
}

// ════════════════════════════════════════════════════════════
// Global bindings (onclick из HTML)
// ════════════════════════════════════════════════════════════

Object.assign(window, {
    linkerApply:        applyAndStart,
    linkerStopStream:   stopStream,
    linkerResumeStream: resumeStream,
});