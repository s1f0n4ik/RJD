/**
 * linker/stream.js — Просмотр стрима: WebRTC, overlay, stop/resume
 */
'use strict';

import { log, showToast } from '../utils/utility.js';
import {
    createWebRTCSession, connectWebRTC, closeWebRTC,
    main_ws_url, wsUrl,
} from '../core/webrtc.js';
import { linkerState } from '../core/linker-state.js';
import { stopLinker }  from './linker-data.js';

// ── Внешняя зависимость (устанавливается из index.js) ────────
let _getClientId = () => 'unknown';

export function setGetClientId(fn) { _getClientId = fn; }

// ── WebRTC-сессия ────────────────────────────────────────────
const linkerRtc = createWebRTCSession();
let _reconnectLock = false;

// ════════════════════════════════════════════════════════════
// Вход / выход из streaming view
// ════════════════════════════════════════════════════════════

export function enterStreamingView() {
    document.getElementById('linkerSetupBlock')?.classList.add('hidden');
    document.getElementById('linkerStreamBlock')?.classList.remove('hidden');
    document.getElementById('linkerStreamPill')?.classList.add('hidden');

    if (linkerState.streamId) {
        _connectRTC();
    } else {
        log('Cannot start WebRTC: no streamId', 'warn');
    }
}

export function exitStreamingView() {
    closeWebRTC(linkerRtc);

    const video = document.getElementById('linkerVideo');
    if (video) video.srcObject = null;

    document.getElementById('linkerSetupBlock')?.classList.remove('hidden');
    document.getElementById('linkerStreamBlock')?.classList.add('hidden');
    document.getElementById('linkerStreamPill')?.classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════
// Stop / Resume
// ════════════════════════════════════════════════════════════

export async function stopStream() {
    try {
        await stopLinker();
    } catch (e) {
        log(`Linker: stop failed: ${e.message}`, 'warn');
    }
    exitStreamingView();
    renderResumeButton();
}

export function resumeStream() {
    if (!linkerState.streaming || !linkerState.streamId) return;
    enterStreamingView();
}

// ════════════════════════════════════════════════════════════
// Resume button (sticky pill)
// ════════════════════════════════════════════════════════════

export function renderResumeButton() {
    const pill = document.getElementById('linkerStreamPill');
    if (!pill) return;

    const text = pill.querySelector('.linker-stream-pill-text');
    if (linkerState.streaming) {
        pill.classList.add('active');
        pill.disabled = false;
        if (text) text.textContent = 'Подключиться к потоку';
    } else {
        pill.classList.remove('active');
        pill.disabled = true;
        if (text) text.textContent = 'Поток не активен';
    }
}

// ════════════════════════════════════════════════════════════
// WebRTC подключение
// ════════════════════════════════════════════════════════════

function _connectRTC() {
    if (!main_ws_url) {
        showToast('RTC', 'Не задан WS URL', 'err');
        return;
    }

    _setOverlay(true, 'Подключение RTC...');
    _setRtcState('connecting');

    connectWebRTC(linkerRtc, {
        streamId: linkerState.streamId,
        clientId: _getClientId(),
        wsUrl:    wsUrl(`/signaling/client/${linkerState.streamId}`),

        onTrack: (e) => {
            const video = document.getElementById('linkerVideo');
            if (video) video.srcObject = e.streams[0];
            _setOverlay(false);
        },

        onIceStateChange: (s) => {
            _setIceState(s);
        },

        onConnectionStateChange: (s) => {
            _setRtcState(s);
            if (s === 'failed' || s === 'disconnected' || s === 'closed') {
                _setOverlay(true, 'RTC соединение потеряно');
            }
        },

        onError: (e) => {
            log(`RTC error: ${e}`, 'err');
            _setOverlay(true, 'RTC ошибка');
        },

        onClose: () => {
            _setOverlay(true, 'RTC закрыт');
            _setRtcState('disconnected');
        },
    });
}

export async function reconnectRTC() {
    if (_reconnectLock) return;
    _reconnectLock = true;
    _setOverlay(true, 'Переподключение...');
    closeWebRTC(linkerRtc);
    await new Promise(r => setTimeout(r, 5000));
    _connectRTC();
    _reconnectLock = false;
}

// ════════════════════════════════════════════════════════════
// UI helpers (локальные для стрима)
// ════════════════════════════════════════════════════════════

function _setRtcState(s) {
    const el = document.getElementById('linkerRtcStatus');
    if (!el) return;
    el.textContent = s;
    el.classList.remove('connected', 'failed');
    if (s === 'connected') el.classList.add('connected');
    if (s === 'failed' || s === 'disconnected') el.classList.add('failed');
}

function _setIceState(s) {
    const el = document.getElementById('linkerIceStatus');
    if (el) el.textContent = `ICE: ${s}`;
}

function _setOverlay(show, text = '') {
    const overlay = document.getElementById('linkerStreamOverlay');
    const label   = document.getElementById('linkerStreamOverlayText');
    if (label) label.textContent = text;
    overlay?.classList.toggle('hidden', !show);
}