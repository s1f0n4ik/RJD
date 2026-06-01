/**
 * projection/server.js — Запросы к серверу и обработка ответов
 */
'use strict';

import { log, showToast }   from '../utils/utility.js';
import { projState, projUpdateUI } from '../core/projection-consts.js';
import { renderProjCamList } from '../components/cam-list.js';
import { projDraw }          from '../components/canvas.js';
import { showProjectionCanvas } from '../components/proj-result.js';

// ── Ссылки, устанавливаемые через index.js (без циклических импортов) ─
let _sendWSMessage      = () => {};
let _renderVehicleList  = () => {};
let _closeLutSaveModal  = () => {};
export function setSendWSMessage(fn)     { _sendWSMessage = fn; }
export function setRenderVehicleList(fn) { _renderVehicleList = fn; }
export function setCloseLutModal(fn)     { _closeLutSaveModal = fn; }

// ── Типы / методы ────────────────────────────────────────────
const TYPE  = 'projection_configuration';
const M     = {
    GET_LIST:   'get_list',
    SET_PRESET: 'set_preset',
    APPLY_WARP: 'apply_warp',
    SAVE_LUT:   'save_lut',
};

// ════════════════════════════════════════════════════════════
// Requests
// ════════════════════════════════════════════════════════════

export function requestProjectionList() {
    _sendWSMessage(TYPE, { method: M.GET_LIST });
}

export function requestSetProjectionConfiguration(configKey) {
    _sendWSMessage(TYPE, { method: M.SET_PRESET, config_key: configKey });
}

export function requestWarp(normPoints, activeCam) {
    _sendWSMessage(TYPE, { method: M.APPLY_WARP, key: activeCam, src_points: normPoints });
}

export function requestSaveLut(id, name) {
    _sendWSMessage(TYPE, { method: M.SAVE_LUT, id, name });
}

// ════════════════════════════════════════════════════════════
// Main dispatch (вызывается из birdview/app.js)
// ════════════════════════════════════════════════════════════

export function handleProjectionMessage(msg) {
    const meta = msg.meta ?? {};

    switch (meta.method) {
        case M.GET_LIST:   _onGetList(meta);           return;
        case M.SET_PRESET: _onSetPreset(meta);         return;
        case M.APPLY_WARP: _onApplyWarp(msg, meta);    return;
        case M.SAVE_LUT:   _onSaveLut(msg, meta);      return;
    }
}

// ── get_list ─────────────────────────────────────────────────
function _onGetList(meta) {
    projState.presets = meta.presets ?? [];
    _renderVehicleList();
}

// ── set_preset ───────────────────────────────────────────────
function _onSetPreset(meta) {
    projState.activePreset = {
        config_key: meta.config_key,
        name:       meta.name,
        cameras:    meta.cameras ?? [],
    };

    // Сброс
    projState.activeCam      = null;
    projState.pointsByCam    = {};
    projState.points         = [];
    projState.doneSet        = new Set();
    projState.maxPointsByCam = {};
    projState.camId          = {};
    projState.applied        = false;

    projState.activePreset.cameras.forEach(cam => {
        projState.maxPointsByCam[cam.key] = cam.max_points ?? 0;
        if ((cam.points_count ?? 0) >= (cam.max_points ?? 0) && (cam.max_points ?? 0) > 0) {
            projState.doneSet.add(cam.key);
        }
    });

    renderProjCamList();
    projUpdateUI();
    projDraw();
}

// ── apply_warp ───────────────────────────────────────────────
function _onApplyWarp(msg, meta) {
    const cameraKey = meta.key;

    if (msg.ret !== true) {
        showToast('Warp не применён', meta.error ?? 'Сервер вернул ошибку', 'err');
        return;
    }

    if (msg._imageBytes && msg._imageBytes.byteLength) {
        showProjectionCanvas(msg._imageBytes);
    }

    projState.pointsByCam[cameraKey] = (cameraKey === projState.activeCam)
        ? projState.points.slice()
        : (projState.pointsByCam[cameraKey] ?? []).slice();

    projState.doneSet.add(cameraKey);
    renderProjCamList();

    if (meta.camera_id != null) {
        projState.camId[cameraKey] = meta.camera_id;
        log(`apply_warp: camId[${cameraKey}] = ${meta.camera_id}`, 'info');
    } else {
        log(`apply_warp: no camera_id for <${cameraKey}>`, 'warn');
    }
}

// ── save_lut ─────────────────────────────────────────────────
function _onSaveLut(msg, meta) {
    const btn = document.getElementById('lutSaveConfirmBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }

    if (msg.ret !== true) {
        const err = meta.description ?? 'Сервер вернул ошибку';
        log(`save_lut failed: ${err}`, 'error');
        showToast('Не сохранено', err, 'err');
        return;
    }

    log(`save_lut ok: id=${meta.id ?? '?'}`, 'info');
    showToast('Сохранено', `Конфигурация <${meta.id ?? ''}>`, 'ok');
    _closeLutSaveModal();
}