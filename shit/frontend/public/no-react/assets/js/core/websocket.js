/**
 * js/pages/websocket.js — Основной WebSocket (калибровочные команды).
 *
 * НЕ управляет RTC-сигналингом — за это отвечает core/webrtc.js.
 */
'use strict';

import { state } from './state.js';
import { log }   from '../utils/utility.js';
import { main_ws_url } from './webrtc.js';

// ── DOM ──────────────────────────────────────────────────────
const wsUrlInput = document.getElementById('wsUrl');
const wsStatusEl = document.getElementById('wsStatus');

if (wsUrlInput) {
    wsUrlInput.placeholder = main_ws_url;
    wsUrlInput.value       = main_ws_url;
}

// ── Status pill ──────────────────────────────────────────────
function _setWsStatus(s) {
    if (!wsStatusEl) return;
    wsStatusEl.className = `status-pill ${s}`;
    wsStatusEl.querySelector('.status-text').textContent =
        { connected: 'WS: OK', connecting: 'WS: ...', disconnected: 'WS: —' }[s] ?? 'WS: ?';
}

// ── Send ─────────────────────────────────────────────────────
export function sendWS(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        log('WS не открыт, отправка невозможна', 'err');
        return false;
    }
    state.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
}

export function sendWSMessage(type, meta = {}, ret = 'none') {
    return sendWS({
        type,
        client_id: state.clientId,
        camera:    state.streamId,
        meta,
        ret,
    });
}

// ── Connect / Disconnect ─────────────────────────────────────
let _onMessageCb = null;
let _onCloseCb   = null;

export function setOnMessage(fn) { _onMessageCb = fn; }
export function setOnClose(fn)   { _onCloseCb   = fn; }

export function connectWS() {
    const url = wsUrlInput?.value.trim();
    if (!url) return;

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        log('WS уже подключён', 'warn');
        return;
    }

    _setWsStatus('connecting');
    log(`Подключение к ${url}...`);

    state.ws            = new WebSocket(url);
    state.ws.binaryType = 'arraybuffer';

    state.ws.onopen = () => {
        _setWsStatus('connected');
        log('WebSocket подключён', 'ok');
    };

    state.ws.onerror = (e) => {
        _setWsStatus('disconnected');
        log('WebSocket ошибка: ' + e.message, 'err');
    };

    state.ws.onclose = () => {
        sendWS({
            type: 'close', client_id: state.clientId,
            camera: state.streamId,
            meta: { description: `close websocket from ${state.clientId}` },
            ret: 'none',
        });
        _setWsStatus('disconnected');
        _onCloseCb?.();
        log('WebSocket закрыт', 'warn');
    };

    state.ws.onmessage = (event) => {
        const data = event.data;

        // Бинарный фрейм
        if (data instanceof ArrayBuffer) {
            _onMessageCb?.(_parseBinary(data));
            return;
        }

        let msg;
        try { msg = JSON.parse(data); }
        catch { log('Не удалось разобрать сообщение: ' + data, 'err'); return; }

        log(`← ${msg.type} | ret=${msg.ret}`, msg.ret === false ? 'err' : 'info');
        _onMessageCb?.(msg);
    };
}

export function disconnectWS() {
    if (state.ws) { state.ws.close(); state.ws = null; }
    _setWsStatus('disconnected');
    log('WS отключён', 'warn');
}

// ── Бинарный парсинг ─────────────────────────────────────────
function _parseBinary(buffer) {
    const view     = new DataView(buffer);
    const jsonSize = (view.getUint8(0) << 24) | (view.getUint8(1) << 16) |
        (view.getUint8(2) << 8)  |  view.getUint8(3);

    const jsonBytes  = new Uint8Array(buffer, 4, jsonSize);
    const imageBytes = new Uint8Array(buffer, 4 + jsonSize);

    let msg = {};
    try { msg = JSON.parse(new TextDecoder().decode(jsonBytes)); } catch {}
    msg._imageBytes = imageBytes;
    return msg;
}