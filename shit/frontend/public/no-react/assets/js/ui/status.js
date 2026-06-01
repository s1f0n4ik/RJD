/**
 * birdview/ui.js — UI-утилиты: статусы, панели, видео, кнопки
 */
'use strict';

// ── Status pills ─────────────────────────────────────────────
const rtcWsStatusEl = document.getElementById('rtcWsStatus');
const rtcStatusEl   = document.getElementById('rtcStatus');
const iceStateEl    = document.getElementById('iceState');
const connStateEl   = document.getElementById('connState');
const calStateEl    = document.getElementById('calibrationState');
const distStateEl   = document.getElementById('distortionState');
const saveBtn       = document.getElementById('saveConfigBtn');
const streamIdTag   = document.getElementById('streamId');
const frameInfoEl   = document.getElementById('frameInfo');
const remoteVideo   = document.getElementById('remoteVideo');

export function setRtcWsStatus(s) {
    if (!rtcWsStatusEl) return;
    rtcWsStatusEl.className = `status-pill ${s}`;
    rtcWsStatusEl.querySelector('.status-text').textContent =
        { connected: 'RTC WS: OK', connecting: 'RTC WS: ...', disconnected: 'RTC WS: —' }[s] ?? 'RTC WS: ?';
}

export function setRtcStatus(s) {
    if (!rtcStatusEl) return;
    rtcStatusEl.className = `status-pill ${s}`;
    rtcStatusEl.querySelector('.status-text').textContent =
        { connected: 'RTC: OK', connecting: 'RTC: ...', disconnected: 'RTC: —' }[s] ?? 'RTC: ?';
}

export function setIceState(s) {
    if (!iceStateEl) return;
    iceStateEl.textContent = `ICE: ${s}`;
    iceStateEl.className = 'state-badge ' +
        ({ connected: 'ok', completed: 'ok', failed: 'err', disconnected: 'err' }[s] ?? 'warn');
}

export function setConnState(s) {
    if (!connStateEl) return;
    connStateEl.textContent = `CONN: ${s}`;
    connStateEl.className = 'state-badge ' +
        ({ connected: 'ok', failed: 'err', disconnected: 'err' }[s] ?? 'warn');
}

export function setCalibrationState(s) {
    if (!calStateEl) return;
    calStateEl.textContent = `Калибровка: ${s}`;
    calStateEl.className = 'state-badge ' +
        ({ installed: 'ok', none: 'err' }[s] ?? 'warn');
}

export function setUndistortionState(s) {
    if (!distStateEl) return;
    distStateEl.textContent = `Коррекция: ${s}`;
    distStateEl.className = 'state-badge ' +
        ({ success: 'ok', failed: 'err' }[s] ?? 'warn');
}

export function setStreamIdTag(text) { if (streamIdTag) streamIdTag.textContent = text; }
export function setFrameInfo(text)   { if (frameInfoEl) frameInfoEl.textContent = text; }

// ── Video ────────────────────────────────────────────────────
export function showVideo() {
    remoteVideo?.classList.add('active');
    syncNoSignal();
}

export function hideVideo() {
    remoteVideo?.classList.remove('active');
    syncNoSignal();
}

export function syncNoSignal() {
    const hasStream = !!remoteVideo?.srcObject;
    ['noSignal', 'noSignalWarp'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const inSameWrapper = el.parentElement?.contains(remoteVideo);
        el.classList.toggle('hidden', inSameWrapper && hasStream);
    });
}

// ── Panel blocks ─────────────────────────────────────────────
export function showPanelBlock(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('visible');
    el.classList.remove('panel-block--hidden');
}

export function hidePanelBlock(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('visible');
    el.classList.add('panel-block--hidden');
}

// ── Save button ──────────────────────────────────────────────
export function enableSaveButton() {
    if (!saveBtn) return;
    saveBtn.disabled = false;
    saveBtn.classList.add('active');
}

export function disableSaveButton() {
    if (!saveBtn) return;
    saveBtn.disabled = true;
    saveBtn.classList.remove('active');
}

// ── Streaming UI ─────────────────────────────────────────────
export function setStreamingUI(isStreaming) {
    const fields     = document.getElementById('cameraFields');
    const btn        = document.getElementById('streamBtn');
    const label      = document.getElementById('streamBtnLabel');
    const loadConfig = document.getElementById('loadConfigurationBtn');

    if (isStreaming) {
        fields?.classList.add('collapsed');
        btn?.classList.add('streaming');
        loadConfig?.classList.remove('collapsed');
        if (label) label.textContent = '■ Закрыть стрим';
        showPanelBlock('calibrationBlock');
    } else {
        fields?.classList.remove('collapsed');
        btn?.classList.remove('streaming');
        loadConfig?.classList.add('collapsed');
        hidePanelBlock('calibrationBlock');
        hidePanelBlock('correctionBlock');
        disableSaveButton();
        if (label) label.textContent = '▶ Запустить стрим';
    }
}

// ── Fullscreen ───────────────────────────────────────────────
export function toggleFullscreen() {
    const el = document.getElementById('videoWrapper');
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
}