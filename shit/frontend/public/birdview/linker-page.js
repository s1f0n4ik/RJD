// linker.js — отдельный модуль страницы линкера
//
// Зависимости из app.js (импортируем то, что есть):
//   - state, sendRTC, connectRtcWS, closeRTC, hideVideo, showVideo
//   - dom.remoteVideo
//   - log, showToast
//
// Если у тебя структура импорта другая — поправь импорты ниже.

import { log, showToast } from "./utility.js";
import { PROJ_POSITION_LABELS } from "./projection.js"
import {state} from "./app.js"
import {main_ws_url, wsUrl} from './webrtc.js';

import {
    createWebRTCSession,
    connectWebRTC,
    closeWebRTC
} from './webrtc.js';

const linkerRtc = createWebRTCSession();


// ─────────────────────────────────────────────────────────────
// State модуля
// ─────────────────────────────────────────────────────────────
const linkerState = {
    exports:        [],    // [{id, name, cameras:[key,...]}]
    cameras:        [],    // только type=3, [{id, display_name}]
    selectedExport: null,  // {id, name, cameras:[...]}
    bindings:       {},    // { [key]: camera_id }
    streaming:      false,
    streamId:       null,  // приходит от /linker/start
};

// Утилита: REST с JSON
async function _restJson(method, path, body) {
    const opts = {
        method,
        headers: { 'Accept': 'application/json' },
    };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${path}`, opts);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path}: ${res.status} ${text}`);
    }
    return res.json();
}

// ─────────────────────────────────────────────────────────────
// Загрузка данных
// ─────────────────────────────────────────────────────────────
async function loadExports() {
    try {
        const json = await _restJson('GET', '/linker/exports');
        linkerState.exports = json.data?.exports ?? json.exports ?? [];
        log(`Linker: loaded ${linkerState.exports.length} exports`, 'info');
        _renderExportsList();
    } catch (e) {
        log(`Linker: loadExports failed: ${e.message}`, 'error');
        showToast('Не удалось загрузить', e.message, 'err');
    }
}

async function loadCameras() {
    try {
        const json = await _restJson('GET', '/api/camera');
        const all = json.data?.cameras ?? {};
        // type=3 → как ты сказал
        linkerState.cameras = Object.entries(all)
            .filter(([_id, c]) => c.type === 3)
            .map(([id, c]) => ({ id, display_name: c.display_name ?? id }));
        log(`Linker: loaded ${linkerState.cameras.length} cameras (type=3)`, 'info');
    } catch (e) {
        log(`Linker: loadCameras failed: ${e.message}`, 'error');
        showToast('Не удалось получить камеры', e.message, 'err');
    }
}

async function loadStatus() {
    try {
        const json = await _restJson('GET', '/linker/status');
        const data = json.data ?? json;
        linkerState.streaming = !!data.running;
        linkerState.streamId  = data.stream_id ?? null;
        log(`Loaded status: running: ${linkerState.streaming}; streamId: ${linkerState.streamId}`);
        _renderResumeButton();
    } catch (e) {
        log(`Linker: status failed: ${e.message}`, 'warn');
    }
}

// ─────────────────────────────────────────────────────────────
// Рендер: список конфигураций
// ─────────────────────────────────────────────────────────────
function _renderExportsList() {
    const list = document.getElementById('linkerExportsList');
    list.innerHTML = '';

    if (!linkerState.exports.length) {
        list.innerHTML = `<div class="custom-select-empty">Нет конфигураций</div>`;
        return;
    }

    linkerState.exports.forEach(exp => {
        const el = document.createElement('div');
        const isSelected = linkerState.selectedExport?.id === exp.id;
        el.className = 'linker-list-item' + (isSelected ? ' selected' : '');
        el.innerHTML = `
            <div class="linker-list-main">
                <span class="linker-list-name">${exp.name ?? exp.id}</span>
                <span class="linker-list-id">${exp.id}</span>
            </div>
        `;
        el.onclick = () => selectExport(exp);
        list.appendChild(el);
    });
}

async function selectExport(exp) {
    linkerState.selectedExport = exp;
    linkerState.bindings       = {};

    // Если на сервере уже есть state для этого id — подтянем биндинги.
    try {
        const json = await _restJson('GET', '/linker/state');
        const st = json.data ?? json;
        if (st.export_id === exp.id && st.cameras) {
            linkerState.bindings = { ...st.cameras };
        }
    } catch (_) {
        // нет state — нормально
    }

    _renderExportsList();
    _renderBindings();
    _updateApplyButton();
}

// ─────────────────────────────────────────────────────────────
// Рендер: маппинг key → camera_id
// ─────────────────────────────────────────────────────────────
function _renderBindings() {
    const section = document.getElementById('linkerBindingsSection');
    const list    = document.getElementById('linkerBindings');
    list.innerHTML = '';

    const exp = linkerState.selectedExport;
    if (!exp || !exp.cameras?.length) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    exp.cameras.forEach(key => {
        const currentId = linkerState.bindings[key];
        const label     = PROJ_POSITION_LABELS[key] ?? key;

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
            // Перерисовываем только класс selected у текущей строки, без полного rerender,
            // чтобы открытый dropdown не «прыгал».
            el.classList.toggle('selected', !!v);
            _updateApplyButton();
        };
        // Клик по строке (не на самом селекте) — открыть селект
        el.onclick = (e) => {
            if (e.target === sel || sel.contains(e.target)) return;
            sel.focus();
            sel.click();
        };
        list.appendChild(el);
    });
}

// ─────────────────────────────────────────────────────────────
// Кнопка применения
// ─────────────────────────────────────────────────────────────
function _updateApplyButton() {
    const btn = document.getElementById('linkerApplyBtn');
    const exp = linkerState.selectedExport;
    // Достаточно одной привязки, чтобы дать нажать. Нет смысла блокировать —
    // непривязанные камеры покажутся серыми.
    btn.disabled = !exp;
}

async function applyAndStart() {
    const exp = linkerState.selectedExport;
    if (!exp) return;

    const btn = document.getElementById('linkerApplyBtn');
    btn.disabled    = true;
    const oldText   = btn.textContent;
    btn.textContent = 'Запуск...';

    try {
        await _restJson('POST', '/linker/state', {
            export_id: exp.id,
            cameras:   linkerState.bindings,
        });
        log(`Linker: state saved for <${exp.id}>`, 'info');

        const json = await _restJson('POST', '/linker/start');
        linkerState.streaming = true;
        log(`Linker: started!}`, 'info');

        showToast('Запущено', 'Линкер работает', 'ok');
        _enterStreamingView();
    } catch (e) {
        log(`Linker: start failed: ${e.message}`, 'error');
        showToast('Ошибка запуска', e.message, 'err');
        btn.disabled    = false;
        btn.textContent = oldText;
    }
}

// ─────────────────────────────────────────────────────────────
// Streaming view (WebRTC просмотр)
// ─────────────────────────────────────────────────────────────
function _enterStreamingView() {
    document.getElementById('linkerSetupBlock').classList.add('hidden');
    document.getElementById('linkerStreamBlock').classList.remove('hidden');

    document.getElementById('linkerStreamPill')?.classList.add('hidden');

    if (linkerState.streamId) {
        connectLinkerRTC();
    }
    else {
        log(`Cannot start webRTC: no streamID`, 'warn');
    }
}

function _exitStreamingView() {
    closeWebRTC(linkerRtc);
    const video = document.getElementById('linkerVideo');
    if (video) {
        video.srcObject = null;
    }

    document.getElementById('linkerSetupBlock').classList.remove('hidden');
    document.getElementById('linkerStreamBlock').classList.add('hidden');

    document.getElementById('linkerStreamPill')?.classList.remove('hidden');
}

async function stopStream() {
    try {
        await _restJson('POST', '/linker/stop');
        linkerState.streaming = false;
    } catch (e) {
        log(`Linker: stop failed: ${e.message}`, 'warn');
    }
    _exitStreamingView();
    _renderResumeButton();
}

// «Подключиться к потоку» — без перезапуска Линкера, если он уже работает
function resumeStream() {
    if (!linkerState.streaming || !linkerState.streamId) return;
    _enterStreamingView();
}

function _renderResumeButton() {
    const pill = document.getElementById('linkerStreamPill');
    if (!pill) return;

    const text = pill.querySelector('.linker-stream-pill-text');
    if (linkerState.streaming) {
        pill.classList.add('active');
        pill.disabled = false;
        text.textContent = 'Подключиться к потоку';
    } else {
        pill.classList.remove('active');
        pill.disabled = true;
        text.textContent = 'Поток не активен';
    }
}

function connectLinkerRTC() {

    if (!main_ws_url) {
        showToast('RTC', 'Не задан WS URL', 'err');
        return;
    }

    setRtcOverlay(true, 'Подключение RTC...');
    setRtcState('connecting');

    connectWebRTC(linkerRtc, {
        streamId: linkerState.streamId,
        clientId: state.clientId,
        wsUrl: wsUrl(`/signaling/client/${linkerState.streamId}`),

        onTrack: (e) => {
            const video = document.getElementById('linkerVideo');
            video.srcObject = e.streams[0];
            setRtcOverlay(false);
        },

        onIceStateChange: (state) => {
            setIceState(state);
        },

        onConnectionStateChange: (state) => {
            setRtcState(state);

            if (
                state === 'failed' ||
                state === 'disconnected' ||
                state === 'closed'
            ) {
                setRtcOverlay(true, 'RTC соединение потеряно');
            }
        },

        onError: (e) => {
            log(`RTC error: ${e}`, 'err');
            setRtcOverlay(true, 'RTC ошибка');
        },

        onClose: () => {
            setRtcOverlay(true, 'RTC закрыт');
            setRtcState('disconnected');
        },
    });
}

let linkerReconnectLock = false;

async function reconnectRTC() {
    if (linkerReconnectLock) return;
    linkerReconnectLock = true;
    setRtcOverlay(true, 'Переподключение...');
    closeWebRTC(linkerRtc);

    await new Promise(r => setTimeout(r, 5000));
    connectLinkerRTC();
    linkerReconnectLock = false;
}

function setRtcState(state) {
    const el = document.getElementById('linkerRtcStatus');

    el.textContent = state;
    el.classList.remove('connected', 'failed');

    if (state === 'connected') {
        el.classList.add('connected');
    }
    if (state === 'failed' || state === 'disconnected') {
        el.classList.add('failed');
    }
}

function setIceState(state) {
    const el = document.getElementById('linkerIceStatus');
    el.textContent = `ICE: ${state}`;
}

function setRtcOverlay(show, text = '') {
    const overlay = document.getElementById('linkerStreamOverlay');
    const label   = document.getElementById('linkerStreamOverlayText');
    label.textContent = text;
    overlay.classList.toggle('hidden', !show);
}

// ─────────────────────────────────────────────────────────────
// Инициализация / выход со страницы
// ─────────────────────────────────────────────────────────────
export async function initLinkerPage() {
    document.getElementById('linkerStreamBlock').classList.add('hidden');
    document.getElementById('linkerSetupBlock').classList.remove('hidden');

    await Promise.all([loadExports(), loadCameras(), loadStatus()]);

    _updateApplyButton();
}

export function disposeLinkerPage() {
    try { closeRTC(); } catch (_) {}
    try { hideVideo(); } catch (_) {}
}

// Глобальные хендлеры onclick из HTML
Object.assign(window, {
    linkerApply:        applyAndStart,
    linkerStopStream:   stopStream,
    linkerResumeStream: resumeStream
});