/**
 * CamCal — Camera Calibration System
 * Этап 1: Подключение к серверу и WebRTC-стрим
 *
 * Протокол:
 *  1. WS connect → отправить {type:"connection", client_id, meta:{camera_id, width, height, fps}}
 *  2. Сервер отвечает {type:"connection", ret:true, meta:{stream_id}} → создать WebRTC
 *  3. WebRTC: сервер шлёт offer → отвечаем answer → обмен ICE
 */

'use strict';

// ── State ────────────────────────────────────────────────────
const state = {
    clientId: 'web_' + Math.random().toString(16).slice(2, 10),
    camera:   null, // { id, displayName, width, height, fps }
    ws:       null,
    rtcWs:    null,
    pc:       null,
    streamId: null,
};

// ── DOM refs ─────────────────────────────────────────────────
const dom = {
    wsStatus:          document.getElementById('wsStatus'),
    rtcWsStatus:       document.getElementById('rtcWsStatus'),
    rtcStatus:         document.getElementById('rtcStatus'),
    remoteVideo:       document.getElementById('remoteVideo'),
    noSignal:          document.getElementById('noSignal'),
    eventLog:          document.getElementById('eventLog'),
    streamIdTag:       document.getElementById('streamId'),
    frameInfo:         document.getElementById('frameInfo'),
    iceState:          document.getElementById('iceState'),
    connState:         document.getElementById('connState'),

    // Секция параметров калибровки
    calibrationBlock:  document.getElementById('calibrationBlock'),
    patternWidth:      document.getElementById('patternWidth'),
    patternHeight:     document.getElementById('patternHeight'),
    patternSize:       document.getElementById('patternSize'),
    patternDetails:    document.getElementById('patternDetails'),
    snapshotCount:     document.getElementById('snapshotCount'),
    checkChessboard:   document.getElementById('chessboardToggle'),

    // Секция коррекции
    correctionBlock:     document.getElementById('correctionBlock'),

    // Страница калибровки
    snapshotList:       document.getElementById('snapshotList'),
    patternState:       document.getElementById('patternState'),
    distortionState:    document.getElementById('distortionState'),
};

// ── CAL refs ─────────────────────────────────────────────────
const _cal = {
    overlay:      () => document.getElementById('calOverlay'),
    spinner:      () => document.getElementById('calSpinner'),
    indeterminate:() => document.getElementById('calIndeterminate'),
    resultIcon:   () => document.getElementById('calResultIcon'),
    stepLabel:    () => document.getElementById('calStepLabel'),
    stepDesc:     () => document.getElementById('calStepDesc'),
    resultTitle:  () => document.getElementById('calResultTitle'),
    resultDesc:   () => document.getElementById('calResultDesc'),
    progressWrap: () => document.getElementById('calProgressWrap'),
    progressFill: () => document.getElementById('calProgressFill'),
    stepCounter:  () => document.getElementById('calStepCounter'),
    itemCounter:  () => document.getElementById('calItemCounter'),
    dismissBtn:   () => document.getElementById('calDismissBtn'),
    video:        () => document.getElementById('remoteVideo'),
    noSignal:    () => document.getElementById('noSignal'),
};

const undist = {
    show:             document.getElementById('distortionDisplayToggle'),

    alphaValue:        document.getElementById('distAlphaValue'),
    alphaSlider:       document.getElementById('distAlphaSlider'),
    alphaMin:          document.getElementById('distAlphaMin'),
    alphaMid:          document.getElementById('distAlphaMid'),
    alphaMax:          document.getElementById('distAlphaMax'),

    zoomValue:         document.getElementById('distZoomValue'),
    zoomSlider:        document.getElementById('distZoomSlider'),
    zoomMin:           document.getElementById('distZoomMin'),
    zoomMid:           document.getElementById('distZoomMid'),
    zoomMax:           document.getElementById('distZoomMax'),

    shiftXValue:       document.getElementById('distShiftXValue'),
    shiftXSlider:      document.getElementById('distShiftXSlider'),
    shiftXMin:         document.getElementById('distShiftXMin'),
    shiftXMid:         document.getElementById('distShiftXMid'),
    shiftXMax:         document.getElementById('distShiftXMax'),

    shiftYValue:       document.getElementById('distShiftYValue'),
    shiftYSlider:      document.getElementById('distShiftYSlider'),
    shiftYMin:         document.getElementById('distShiftYMin'),
    shiftYMid:         document.getElementById('distShiftYMid'),
    shiftYMax:         document.getElementById('distShiftYMax'),
}

const UNDIST_SLIDERS = {
    alpha:  { value: () => undist.alphaValue,  min: () => undist.alphaMin,  mid: () => undist.alphaMid,  max: () => undist.alphaMax,  slider: () => undist.alphaSlider  },
    zoom:   { value: () => undist.zoomValue,   min: () => undist.zoomMin,   mid: () => undist.zoomMid,   max: () => undist.zoomMax,   slider: () => undist.zoomSlider   },
    shiftX: { value: () => undist.shiftXValue, min: () => undist.shiftXMin, mid: () => undist.shiftXMid, max: () => undist.shiftXMax, slider: () => undist.shiftXSlider },
    shiftY: { value: () => undist.shiftYValue, min: () => undist.shiftYMin, mid: () => undist.shiftYMid, max: () => undist.shiftYMax, slider: () => undist.shiftYSlider },
};

// ── Config refs ─────────────────────────────────────────────────
const config = {
    modal:     document.getElementById('loadConfigModal'),
    list:      document.getElementById('configList'),
    detail:    document.getElementById('configDetail'),
};

let _selectedConfigId = null;

const CONFIG_FIELDS = [
    { key: 'id',              label: 'Идентификатор'              },
    { key: 'name',            label: 'Название'                   },
    { key: 'description',     label: 'Описание'                   },
    { key: 'resolution',      label: 'Разрешение'                 },
    { key: 'calibrated',      label: 'Пройдена калибровка'        },
    { key: 'rms',             label: 'RMS'                        },
    { key: 'cameraMatrix',    label: 'Матрица камеры'             },
    { key: 'distCoeffs',      label: 'Матрица коэффициентов'      },
    { key: 'undistorted',     label: 'Пройдена коррекция'         },
    { key: 'map1',            label: 'Матрица map1'               },
    { key: 'map2',            label: 'Матрица map2'               },
];


// ════════════════════════════════════════════════════════════
// Инициализация
// ════════════════════════════════════════════════════════════

dom.snapshotList.addEventListener('click', (e) => {
    const item = e.target.closest('.snapshot-item');
    if (!item) return;

    if (e.target.closest('.btn-icon')) {
        requestRemoveSnapshot(+item.dataset.id);
    } else {
        requestSnapshotFrame(+item.dataset.id);
    }
});

// ════════════════════════════════════════════════════════════
// LOGGING
// ════════════════════════════════════════════════════════════

function log(msg, level = 'info') {
    console.log(`[${level.toUpperCase()}] ${msg}`);

    const now = new Date();
    const time = now.toTimeString().slice(0, 8);

    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;

    dom.eventLog.appendChild(entry);
    dom.eventLog.scrollTop = dom.eventLog.scrollHeight;
}

function clearLog() {
    dom.eventLog.innerHTML = '';
}

// ════════════════════════════════════════════════════════════
// STATUS UI
// ════════════════════════════════════════════════════════════

function setWsStatus(state_) {
    dom.wsStatus.className = `status-pill ${state_}`;
    dom.wsStatus.querySelector('.status-text').textContent =
        { connected: 'WS: OK', connecting: 'WS: ...', disconnected: 'WS: —' }[state_] ?? 'WS: ?';
}

function setRtcWsStatus(state_) {
    dom.rtcWsStatus.className = `status-pill ${state_}`;
    dom.rtcWsStatus.querySelector('.status-text').textContent =
        { connected: 'RTC WS: OK', connecting: 'RTC WS: ...', disconnected: 'RTC WS: —' }[state_] ?? 'RTC WS: ?';
}

function setRtcStatus(state_) {
    dom.rtcStatus.className = `status-pill ${state_}`;
    dom.rtcStatus.querySelector('.status-text').textContent =
        { connected: 'RTC: OK', connecting: 'RTC: ...', disconnected: 'RTC: —' }[state_] ?? 'RTC: ?';
}

function setIceState(s) {
    dom.iceState.textContent = `ICE: ${s}`;
    dom.iceState.className = 'state-badge ' +
        ({ connected: 'ok', completed: 'ok', failed: 'err', disconnected: 'err' }[s] ?? 'warn');
}

function setConnState(s) {
    dom.connState.textContent = `CONN: ${s}`;
    dom.connState.className = 'state-badge ' +
        ({ connected: 'ok', failed: 'err', disconnected: 'err' }[s] ?? 'warn');
}

function setPatternState(s) {
    dom.patternState.textContent = `Pattern: ${s}`;
    dom.patternState.className = 'state-badge ' +
        ({ installed: 'ok', none: 'err' }[s] ?? 'warn');
}

function setDistortionState(s) {
    dom.distortionState.textContent = `Distortion: ${s}`;
    dom.distortionState.className = 'state-badge ' +
        ({ success: 'ok', failed: 'err' }[s] ?? 'warn');
}

function showVideo() {
    dom.remoteVideo.classList.add('active');
    syncNoSignal();
}

function hideVideo() {
    dom.remoteVideo.classList.remove('active');
    syncNoSignal();
}

// ════════════════════════════════════════════════════════════
// WEBSOCKET
// ════════════════════════════════════════════════════════════

function connectWS() {
    const url = document.getElementById('wsUrl').value.trim();
    if (!url) return;

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        log('WS уже подключён', 'warn');
        return;
    }

    setWsStatus('connecting');
    log(`Подключение к ${url}...`);

    state.ws = new WebSocket(url);
    state.ws.binaryType = "arraybuffer";

    state.ws.onopen    = onWsOpen;
    state.ws.onmessage = onWsMessage;
    state.ws.onerror   = onWsError;
    state.ws.onclose   = onWsClose;
}

function disconnectWS() {
    closeRTC();
    if (state.ws) {
        state.ws.close();
        state.ws = null;
    }
    if (state.rtcWs) {
        state.rtcWs.close();
        state.rtcWs = null;
    }
    setWsStatus('disconnected');
    setRtcWsStatus('disconnected');
    setRtcStatus('disconnected');
    hideVideo();
    log('WS отключён', 'warn');
}

function connectRtcWS(streamId) {
    if (!state.ws) {
        log('Основной WS не инициализирован', 'err');
        return;
    }

    const baseUrl = document.getElementById('wsUrl').value.trim();
    if (!baseUrl) return;

    const u = new URL(baseUrl);
    u.pathname = `/client/${streamId}`;

    const url = u.toString();

    log(`Подключение RTC WebSocket: ${url}`);

    state.rtcWs = new WebSocket(url);

    state.rtcWs.onmessage = onRtcWsMessage;
    state.rtcWs.onopen    = onRtcWsOpen;
    state.rtcWs.onerror   = onRtcWsError;
    state.rtcWs.onclose   = onRtcWsClose;
}

function sendWS(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        log('WS не открыт, отправка невозможна', 'err');
        return false;
    }
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    state.ws.send(str);
    return true;
}

function sendRTC(payload) {
    if (!state.rtcWs || state.rtcWs.readyState !== WebSocket.OPEN) {
        log('RTC WS не открыт', 'err');
        return;
    }
    state.rtcWs.send(JSON.stringify(payload));
}

// ── WS handlers ──────────────────────────────────────────────
function onWsOpen() {
    setWsStatus('connected');
    log('WebSocket подключён', 'ok');
}

function onWsError(e) {
    setWsStatus('disconnected');
    log('WebSocket ошибка: ' + e.message, 'err');
}

function onWsClose() {
    sendWS({
        type:        'close',
        client_id:   state.clientId,
        camera:      state.streamId,
        meta: {
            description: `close websocket from ${state.clientId}`,
        },
        ret:         'none',
    });
    setWsStatus('disconnected');
    setStreamingUI(false)
    hidePanelBlock(dom.calibrationBlock.id)
    hidePanelBlock(dom.correctionBlock.id)
    log('WebSocket закрыт', 'warn');
}

function onWsMessage(event) {
    const data = event.data;

    // Бинарный фрейм (не используется в WebRTC-режиме, но оставим разбор)
    if (data instanceof ArrayBuffer) {
        handleBinaryMessage(data);
        return;
    }

    let msg;
    try {
        msg = JSON.parse(data);
    } catch (e) {
        log('Не удалось разобрать сообщение: ' + data, 'err');
        return;
    }

    log(`← ${msg.type} | ret=${msg.ret}`, msg.ret === false ? 'err' : 'info');
    dispatchServerMessage(msg);
}

// ── RTC WS handlers ──────────────────────────────────────────────
function onRtcWsOpen() {
    setRtcWsStatus('connected');
    log('RTC WebSocket подключён', 'ok');
    sendRTCReadySignal();
    // Смотрим состояние
    sendWS({
        type:        'status',
        client_id:   state.clientId,
        meta: {},
    });
}

function onRtcWsError(e) {
    setRtcWsStatus('disconnected');
    log('WebSocket ошибка: ' + e.message, 'err');
    closeRTC();
}

function onRtcWsClose() {
    setRtcWsStatus('disconnected');
    log('RTC WebSocket закрыт', 'warn');
    hidePanelBlock(dom.calibrationBlock.id)
    hidePanelBlock(dom.correctionBlock.id)
    closeRTC();
    hideVideo();
}

function onRtcWsMessage(event) {
    let msg;

    try {
        msg = JSON.parse(event.data);
    } catch (e) {
        log('RTC WS: ошибка парсинга', 'err');
        return;
    }

    log(`[RTC WS] ← ${msg.type}`);
    dispatchWebRtcSignalingMessage(msg);
}


// ════════════════════════════════════════════════════════════
// MESSAGE DISPATCH
// ════════════════════════════════════════════════════════════

/**
 * Серверное сообщение:
 * {
 *   type:   string,
 *   ret:    bool,
 *   client: string | null,
 *   sender: string | null,
 *   meta:   object
 * }
 */
function dispatchServerMessage(msg) {
    if (!msg.ret && msg.meta?.description) {
        log(`Сервер: ошибка — ${msg.meta.description}`, 'err');
    }

    switch (msg.type) {
        case 'connection': handleConnectionResponse(msg); break;
        case 'add_image': handleAddImageResponse(msg); break;
        case 'delete_image': handleRemoveSnapshot(msg); break;
        case 'get_image': handleSnapshotFrame(msg); break;
        case 'chessboard': handleChessboardResponse(msg); break;
        case 'status': handleCalibrationStatus(msg); break;
        case 'get_pattern': handleGetCalibrationPattern(msg); break;
        //case 'get_distortion': handleGetCalibrationDistorion(msg); break;
        case 'calibration_start': handleStartCalibration(msg); break;
        case 'calibration_progress': handleCalibrateStep(msg); break;
        case 'calibration_compute': handleCalibrationCompute(msg); break;
        case 'calibration_result': handleCalibrationResult(msg); break;
        case 'undistort_compute': handleDistortionCompute(msg); break;
        case 'view_undistort': handleOnDistortionShow(msg); break;
        default:
            log(`Неизвестный тип: ${msg.type}. Сообщение: ${msg}`, 'warn');
    }
}

function dispatchWebRtcSignalingMessage(msg) {
    if (!msg.ret && msg.description) {
        log(`Сигналинг: ошибка — ${msg.description}`, 'err');
    }

    switch (msg.type) {
        case 'connection': handleWebRTCConnectionResponse(msg); break;
        case 'offer':      handleRTCOffer(msg);           break;
        case 'answer':     handleRTCAnswer(msg);          break;
        case 'ice':        handleRTCIce(msg);             break;
        default:
            log(`Неизвестный тип: ${msg.type}`, 'warn');
    }
}

// ── connection ───────────────────────────────────────────────
function handleConnectionResponse(msg) {
    if (!msg.ret) return; // ошибка уже залогирована

    const meta = msg.meta ?? {};
    state.streamId = meta.id_stream ?? null;

    if (state.streamId) {
        dom.streamIdTag.textContent = `stream: ${state.streamId}`;
        log(`Стрим запущен: ${state.streamId}`, 'ok');
    }
    else {
        log(`Ошибка в получении идентификатора стрима: ${state.streamId}`, 'err');
        return;
    }

    log('Сервер готов. Инициируем WebRTC подключение...', 'ok');
    connectRtcWS(state.streamId);
}

// ── Подключение по webRTC ───────────────────────────────────────────────
function handleWebRTCConnectionResponse(msg) {
    if (!msg.ret)  {
        log(`Ошибка подключения WebRTC: ${msg.description}`);
        return;
    }

    createPeerConnection();
}

// ── WebRTC offer (сервер → клиент) ──────────────────────────
async function handleRTCOffer(msg) {
    if (!state.pc) {
        log('Получен offer, но RTCPeerConnection не создан', 'err');
        return;
    }

    log('Получен SDP offer от сервера');

    try {
        await state.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);

        sendRTC({
            type:        'answer',
            client_id:   state.clientId,
            camera:      state.camera.id,
            description: 'SDP answer from client',
            sdp:         answer.sdp,
        });

        log('SDP answer отправлен');
    } catch (e) {
        log('Ошибка при создании answer: ' + e.message, 'err');
    }
}

// ── WebRTC answer (сервер → клиент) ─────────────────────────
async function handleRTCAnswer(msg) {
    if (!state.pc) return;

    try {
        await state.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        log('Remote description установлен из answer');
    } catch (e) {
        log('Ошибка setRemoteDescription(answer): ' + e.message, 'err');
    }
}

// ── ICE candidate ────────────────────────────────────────────
async function handleRTCIce(msg) {
    if (!state.pc) return;

    try {
        await state.pc.addIceCandidate(new RTCIceCandidate({
            candidate:     msg.candidate,
            sdpMLineIndex: msg.sdpMLineIndex,
            sdpMid:        msg.sdpMid ?? undefined,
        }));
    } catch (e) {
        log('Ошибка addIceCandidate: ' + e.message, 'err');
    }
}

// ════════════════════════════════════════════════════════════
// Выбор камеры
// ════════════════════════════════════════════════════════════

function toggleCameraSelect() {
    const wrap = document.getElementById('cameraSelect');
    const isOpen = wrap.classList.contains('open');
    if (isOpen) {
        closeCameraSelect();
    } else {
        openCameraSelect();
    }
}

function openCameraSelect() {
    const wrap = document.getElementById('cameraSelect');
    wrap.classList.add('open');
    fetchCameraList();

    // закрыть при клике вне
    setTimeout(() => document.addEventListener('click', _onCameraSelectOutside), 0);
}

function closeCameraSelect() {
    document.getElementById('cameraSelect').classList.remove('open');
    document.removeEventListener('click', _onCameraSelectOutside);
}

function _onCameraSelectOutside(e) {
    if (!document.getElementById('cameraSelect').contains(e.target)) {
        closeCameraSelect();
    }
}

async function fetchCameraList() {
    const list = document.getElementById('cameraSelectList');
    list.innerHTML = `<div class="custom-select-loading">Загрузка...</div>`;

    try {
        const res  = await fetch('http://192.168.1.2:7778/camera');
        const json = await res.json();

        if (json.error) throw new Error(json.error);

        const cameras = json?.data?.cameras ?? {};
        const items   = _filterCameras(cameras);

        _renderCameraList(items);

    } catch (err) {
        list.innerHTML = `<div class="custom-select-empty">Ошибка загрузки</div>`;
        console.error('fetchCameraList:', err);
    }
}

/* Оставить только camera_type === 3 и имеющие поток type === 2 */
function _filterCameras(cameras) {
    const result = [];

    for (const [id, cam] of Object.entries(cameras)) {
        if (cam.camera_type !== 3) continue;

        const subStream = Object.values(cam.streams ?? {}).find(s => s.type === 1);
        if (!subStream) continue;

        result.push({
            id,
            displayName: cam.display_name,
            width:  subStream.width,
            height: subStream.height,
            fps:    subStream.fps,
        });
    }

    return result;
}

function _renderCameraList(items) {
    const list = document.getElementById('cameraSelectList');
    list.innerHTML = '';

    if (!items.length) {
        list.innerHTML = `<div class="custom-select-empty">Нет доступных камер</div>`;
        return;
    }

    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'custom-select-item' + (state.camera?.id === item.id ? ' selected' : '');
        el.innerHTML = `<span class="custom-select-item-name">${item.displayName}</span>`;
        el.onclick = () => selectCamera(item);
        list.appendChild(el);
    });
}

function selectCamera(item) {
    state.camera = item;

    const label = document.getElementById('cameraSelectLabel');
    label.textContent = item.displayName;
    label.classList.add('selected');

    closeCameraSelect();

    console.log('camera selected:', item);

    document.getElementById('width').value = item.width;
    document.getElementById('height').value = item.height;
    // item.id, item.displayName, item.width, item.height, item.fps
}

/* Получить текущий выбор извне */
function getSelectedCamera() {
    return _cameraSelect.selected;
}

// ════════════════════════════════════════════════════════════
// CALIBRATION — STEP 1 ACTIONS
// ════════════════════════════════════════════════════════════

function startCalibrationStream() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        log('Сначала подключитесь к WebSocket серверу', 'warn');
        return;
    }

    if (!state.camera) {
        log('Не выбрана камера для подключения!');
        return;
    }

    const camera_id         = state.camera.id;
    const width     = parseInt(state.camera.width);
    const height    = parseInt(state.camera.height);
    const fps       = parseInt(state.camera.fps);

    const msg = {
        type:      'connection',
        client_id:  state.clientId,
        meta: {
            camera_id,
            width,
            height,
            fps,
        },
    };

    log(`Запрос стрима: ${camera_id} @ ${width}×${height} / ${fps}fps`);
    sendWS(msg);
}

// Работа с паттерном
function savePattern() {
    const width  = parseInt(dom.patternWidth.value);
    const height = parseInt(dom.patternHeight.value);
    const size   = parseFloat(dom.patternSize.value);

    sendWS({
        type:      'calibrate_pattern',
        client_id: state.clientId,
        meta: {
            width: width,
            height: height,
            size: size
        }
    });
}

function takeSnapshot() {
    sendWS({
        type:      'add_image',
        client_id: state.clientId,
        meta: {}
    });

    log(`Request taking snapshot`, 'ok');
}

function handleAddImageResponse(msg) {
    if (!msg.ret) {
        log(`Ошибка создания снимка: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        return;
    }
    let count = msg.meta?.count ?? 0;
    let added_id = msg.meta?.added_id ?? -1;

    dom.snapshotCount.textContent = count;
    dom.snapshotList.appendChild(createSnapshotItem(added_id));
    log(`Снимок добавлен под id=${added_id}. Всего: ${count}`, 'ok');
}

function onChessboardClick(event) {
    event.preventDefault();

    const desired = !dom.checkChessboard.checked;
    sendWS({
        type:      'chessboard',
        client_id: state.clientId,
        meta:      {
            show: !desired
        }
    });

    log(`Запрос обнаружения шахматки: ${desired ? 'вкл' : 'выкл'}`);
}

function handleChessboardResponse(msg) {
    if (!msg.ret) {
        log(`Сервер отклонил переключение: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        return;
    }
    let show_b = msg.meta?.show ?? false;
    // Только здесь реально меняем состояние чекбокса
    dom.checkChessboard.checked = show_b;
    log(`Обнаружение шахматки: ${show_b ? 'вкл' : 'выкл'}`, 'ok');
}

function handleCalibrationStatus(msg) {
    if (!msg.ret) {
        log(`Сервер не передал статус: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        return;
    }

    let has_pattern = msg.meta?.pattern ?? false;
    setPatternState(has_pattern ? 'installed' : 'none');
    if (msg.meta?.pattern ?? false) {
        sendWS({
            type: 'get_pattern',
            client_id: state.clientId,
            meta: {}
        });
    }
    else {
        dom.patternDetails.removeAttribute('data-set');
        dom.patternDetails.open = true;
    }

    let has_distortion = msg.meta?.distortion ?? false;
    setDistortionState(has_distortion ? 'success' : 'failed');
    if (has_distortion) {
        sendWS({
            type: 'get_distortion',
            client_id: state.clientId,
            meta: {}
        });
    }
}

function handleGetCalibrationPattern(msg) {
    if (!msg.ret) {
        log(`Сервер не смог отправить паттерн: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        setPatternState('none');
        return;
    }

    dom.patternWidth.textContent = msg.meta?.width ?? null;
    dom.patternHeight.textContent = msg.meta?.height ?? null;
    dom.patternSize.textContent = msg.meta?.size ?? null;

    setPatternState('installed')

    // Если будут добавлться еще - приписать
    dom.patternDetails.setAttribute('data-set', '');
    dom.patternDetails.open = false;
}

// ════════════════════════════════════════════════════════════
// WebRTC PEER CONNECTION
// ════════════════════════════════════════════════════════════

function createPeerConnection() {
    if (state.pc) closeRTC();

    log('Создание RTCPeerConnection...');
    setRtcStatus('connecting');

    state.pc = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            {
                urls: 'turn:172.25.78.169:3478',
                username: 'niac',
                credential: 'VniiTest'
            }
        ],
    });

    state.pc.addTransceiver('video', { direction: 'recvonly' });

    state.pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        sendRTC({
            type:             'ice',
            client_id:        state.clientId,
            camera:           state.camera.id,
            candidate:        e.candidate.candidate,
            sdpMLineIndex:    e.candidate.sdpMLineIndex,
            sdpMid:           e.candidate.sdpMid,
            usernameFragment: e.candidate.usernameFragment,
        });
    };

    state.pc.oniceconnectionstatechange = () => {
        const s = state.pc.iceConnectionState;
        log(`ICE state: ${s}`);
        setIceState(s);
    };

    state.pc.onconnectionstatechange = () => {
        const s = state.pc.connectionState;
        log(`Conn state: ${s}`);
        setConnState(s);
        if (s === 'connected') {
            setRtcStatus('connected');
            setStreamingUI(true);
        }
        if (s === 'failed' || s === 'disconnected') {
            setRtcStatus('disconnected');
            setStreamingUI(false);
            hideVideo();
        }
    };

    state.pc.ontrack = (e) => {
        log('Медиапоток получен', 'ok');
        dom.remoteVideo.srcObject = e.streams[0];
        showVideo();
        dom.frameInfo.textContent = `${e.streams[0].id.slice(0, 8)}...`;
    };
}

/**
 * После создания RTCPeerConnection отправляем серверу сигнал готовности.
 * Сервер в ответ пришлёт SDP offer.
 */
function sendRTCReadySignal() {
    if (!state.streamId) {
        log(`WebRTC ошибка: нет streamId для организации подключения`);
        return;
    }
    sendRTC({
        type:        'connection',
        client_id:   state.clientId,
        camera:      state.streamId,
        description: 'webrtc_ready',
        ret:         'none',
    });
    log(`WebRTC ready → camera=${state.camera.id}`);
}

function closeRTC() {
    if (!state.pc) return;

    if (state.rtcWs && state.rtcWs.readyState === WebSocket.OPEN) {
        sendRTC({
            type:        'close',
            client_id:   state.clientId,
            camera:      state.streamId,
            description: 'client disconnect',
        });
    }

    if (state.rtcWs) {
        state.rtcWs.close();
        state.rtcWs = null;
    }

    state.pc.close();
    state.pc = null;

    if (dom.checkChessboard) dom.checkChessboard.checked = false;
    if (dom.snapshotCount) dom.snapshotCount.textContent = '0';

    setRtcStatus('disconnected');
    setIceState('—');
    setConnState('—');
    clearSnapshotList();
    log('RTCPeerConnection закрыт', 'warn');
}

// ════════════════════════════════════════════════════════════
// Функции элементов
// ════════════════════════════════════════════════════════════

function toggleStream() {
    if (state.pc) {
        closeRTC();
        sendWS({
            type:        'close',
            client_id:   state.clientId,
            camera:      state.streamId,
            meta: {
                description: `close websocket from ${state.clientId}`,
            },
            ret:         'none',
        });
        setStreamingUI(false);
        hideVideo();
    } else {
        startCalibrationStream();
    }
}

function setStreamingUI(isStreaming) {
    const fields = document.getElementById('cameraFields');
    const btn    = document.getElementById('streamBtn');
    const label  = document.getElementById('streamBtnLabel');
    const load_config = document.getElementById('loadConfigurationBtn');

    if (isStreaming) {
        fields.classList.add('collapsed');
        btn.classList.add('streaming');
        load_config.classList.remove('collapsed');
        label.textContent = '■ Закрыть стрим';
        showPanelBlock(dom.calibrationBlock.id);
    } else {
        fields.classList.remove('collapsed');
        btn.classList.remove('streaming');
        load_config.classList.add('collapsed');
        hidePanelBlock(dom.calibrationBlock.id)
        hidePanelBlock(dom.correctionBlock.id)
        label.textContent = '▶ Запустить стрим';
    }
}

// ════════════════════════════════════════════════════════════
// PAGE 2 КАЛибровка
// ════════════════════════════════════════════════════════════

function requestRemoveSnapshot(id) {
    sendWS({
        type: 'delete_image',
        client_id: state.clientId,
        meta: {
            id: id,
            all: false,
        }
    });
    //document.getElementById(`snapshot-${id}`)?.remove();
}

function requestClearSnapshotList() {
    sendWS({
        type: 'delete_image',
        client_id: state.clientId,
        meta: {
            id: -1,
            all: true,
        }
    });
}

function clearSnapshotList() {
    dom.snapshotList.innerHTML = '';
    dom.snapshotCount.textContent = '0';
}

function removeSnapshotItem(id, count) {
    document.querySelector(`.snapshot-item[data-id="${id}"]`)?.remove();

    // Пересчёт только data-id и текста
    document.querySelectorAll('.snapshot-item').forEach((item, index) => {
        item.dataset.id = index;
        item.querySelector('.snapshot-item-id').textContent = `# ${String(index).padStart(3, '0')}`;
    });

    dom.snapshotCount.textContent = `${count ?? 0}`;
    log(`Успешно удален скриншот с id=${id}, текущее количество ${count}`);
}

function handleRemoveSnapshot(msg) {
    if (!msg.ret) {
        log(`Ошибка при удалении: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        return;
    }

    let id = msg.meta?.id ?? -1;
    let all = msg.meta?.all ?? false;
    let size = msg.meta?.count ?? -1;

    if (all) {
        clearSnapshotList();
        log('Очистка всех скриншотов', 'ok');
        return;
    }

    if (id === -1 || size === -1) {
        log(
            `Ошибка при удалении элемента: некорректные данные от сервера (id=${id}, size=${size})`,
            'err'
        );
        return;
    }

    removeSnapshotItem(id, size);
}

function createSnapshotItem(id) {
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

function requestSnapshotFrame(id) {
    sendWS({
        type:      'get_image',
        client_id: state.clientId,
        meta:      { id }
    });
}

function handleSnapshotFrame(msg) {
    if (!msg.ret) {
        log(`Ошибка получения кадра: ${msg.meta?.description}`, 'err');
        return;
    }
    const id = msg.meta?.id ?? '?';
    showSnapshotFrame(id, msg._imageBytes);
}

function toggleSnapshotDrawer() {
    const drawer = document.getElementById('snapshotDrawer');
    drawer.classList.toggle('open');
}

// Вызывать при изменении количества снимков
function updateDrawerCount(n) {
    document.getElementById('drawerSnapshotCount').textContent = n;
}

function showSnapshotFrame(id, bytes) {
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url  = URL.createObjectURL(blob);

    const wrapper = document.getElementById('videoWrapper');

    // Убираем video, показываем img
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

    // Индикатор
    document.getElementById('snapshotIndicator').classList.remove('hidden');
    document.getElementById('snapshotIndicatorId').textContent = `snapshot # ${String(id).padStart(3, '0')}`;

    // Кнопка возврата
    document.getElementById('resumeStreamBtn').disabled = false;
}

function resumeStream() {
    const video = document.getElementById('remoteVideo');
    video.style.display = 'block';

    const img = document.getElementById('snapshotFrameImg');
    if (img) {
        if (img._prevUrl) URL.revokeObjectURL(img._prevUrl);
        img.remove();
    }

    document.getElementById('snapshotIndicator').classList.add('hidden');
    document.getElementById('resumeStreamBtn').disabled = true;
}

function setSnapshotUsed(id, used) {
    const item = document.querySelector(`.snapshot-item[data-id="${id}"]`);
    if (!item) return;

    const dot = item.querySelector('.snapshot-used');
    if (!dot) return;

    dot.classList.toggle('used', used);
    dot.title = used ? 'использован' : 'не использован';
}

// Перенос video между wrapper-ами
// video и noSignal — синглтоны, просто перемещаем в нужный wrapper
function moveVideoTo(wrapperId, noSignalId) {
    const video    = document.getElementById('remoteVideo');
    const wrapper = document.getElementById(wrapperId);
    //const wrapper  = document.getElementById(wrapperId);

    wrapper.appendChild(video);
    //wrapper.appendChild(noSignal);

    // Синхронизируем id noSignal (у нас один элемент, просто перемещён)
    //noSignal.id = noSignalId;
}

function syncNoSignal() {
    const hasStream = !!dom.remoteVideo.srcObject;

    ['noSignal', 'noSignal2'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const inSameWrapper = el.parentElement.contains(dom.remoteVideo);
        // Заглушка видна если: нет стрима, ИЛИ video сейчас в другом wrapper-е
        el.classList.toggle('hidden', inSameWrapper && hasStream);
    });
}

// ════════════════════════════════════════════════════════════
// Функции обработки сигналов по калибровке
// ════════════════════════════════════════════════════════════

function calibrateStart() {
    sendWS({
        type:      'calibration_start',
        client_id: state.clientId,
        meta: {}
    });
}

function handleStartCalibration(msg) {
    if (!msg.ret) {
        log(`Ошибка при удалении: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        showToast('Ошибка калибровки', msg.meta?.description ?? 'нет описания ошибки', 'err');
        return;
    }

    let total = msg.meta?.total ?? 0;
    if (total === 0) {
        log(`Ошибка в получении количества калибровочных шагов`, 'err');
    }

    calShowStep({
        label: 'Обработка снимков',
        desc: 'Обнаружение шахматной доски',
        step: 1,
        totalSteps: total,
        progress: 0
    });
}

function handleCalibrateStep(msg) {
    if (!msg.ret) {
        log(`Ошибка при калибровочном шаге: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        return;
    }

    let id = msg.meta?.id ?? -1;
    let current_count = msg.meta?.current_count ?? 0;
    let total = msg.meta?.total ?? 0;
    let is_found = msg.meta?.corners_found ?? false;

    calUpdateProgress({
        step: current_count,
        totalSteps: total,
        progress: current_count / total * 100.0,
        itemCurrent: current_count,
        itemTotal: total
    })

    setSnapshotUsed(id, is_found);
}

function handleCalibrationCompute(msg) {
    if (!msg.ret) {
        log(`Ошибка при переходе на вычисление матрицы: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        return;
    }

    calShowIndeterminate({ label: 'Вычисление', desc: 'Согласно полученным данных идет вычисление матрицы для коррекции искажений...' });
}

function handleCalibrationResult(msg) {
    if (!msg.ret) {
        log(`Ошибка при калибровке: ${msg.meta?.description ?? 'нет описания ошибки'}`, 'err');
        calShowError(
            { title: 'Ошибка калибровки', desc: msg.meta?.description ?? 'нет описания ошибки' }
        );
        return;
    }

    let width = msg.meta?.width ?? -1;
    let height = msg.meta?.height ?? -1;
    let rms = msg.meta?.rms ?? -1;
    let used_images = msg.meta?.used_images ?? -1;
    let total = msg.meta?.total ?? -1;

    if (rms > 1.0) {
        calShowError({
            title: 'Калибровка завершена',
            desc: `Погрешность слишком высокая для дальнейших вычислений: ${rms}px\n
              Добейтейсь значений в пределах 1 пикселя!\n
              Обработано: ${total} снимков, из которых использовано ${used_images}`
        });
    }
    else {
        calShowSuccess({
            title: 'Калибровка завершена',
            desc: `Погрешность в пикселях: ${rms}px\nОбработано: ${total} снимков, из которых использовано ${used_images}`
        });
    }

    setSliderConfig('alpha',  { value: 0.0, min: 0,   max: 1,   decimals: 2 });
    setSliderConfig('zoom',   { value: 1.0, min: 0.1,  max: 2.0, mid: 1.0, decimals: 2 });
    setSliderConfig('shiftX', { value: 0.0, min: -width / 2, max: width / 2, decimals: 0 });
    setSliderConfig('shiftY', { value: 0.0, min: -height / 2, max: height / 2, decimals: 0 });

    // Запуск вычисления undistort
    requestDistortionCompute();
}

// ════════════════════════════════════════════════════════════
// Функции для работы с элементами калибровки
// ════════════════════════════════════════════════════════════

function _calReset() {
    _cal.spinner().style.display      = 'block';
    _cal.indeterminate().style.display= 'none';
    _cal.resultIcon().style.display   = 'none';
    _cal.stepLabel().style.display    = 'none';
    _cal.stepDesc().style.display     = 'none';
    _cal.resultTitle().style.display  = 'none';
    _cal.resultDesc().style.display   = 'none';
    _cal.progressWrap().style.display = 'none';
    _cal.dismissBtn().style.display   = 'none';
    _cal.resultIcon().className       = 'cal-result-icon';
    _cal.resultTitle().className      = 'cal-result-title';
}

/* Показать оверлей, скрыв видео */
function calShow() {
    _cal.video()?.classList.remove('active');
    _cal.noSignal()?.classList.add('hidden');
    _calReset();
    _cal.overlay().style.display = 'flex';
}

/* Скрыть всё, вернуть видео */
function calHide() {
    _cal.overlay().style.display = 'none';
    if (_cal.video()?.srcObject) {
        _cal.video().classList.add('active');
        _cal.noSignal()?.classList.add('hidden');
    } else {
        _cal.noSignal()?.classList.remove('hidden');
    }
}

/*
 * Шаг с прогрессом
 *   calShowStep({ label, desc, step, totalSteps, progress })
 *   progress — 0..100 (опционально, если не передан — нет прогресс-бара)
 */
function calShowStep({ label, desc = '', step = null, totalSteps = null, progress = null } = {}) {
    calShow();
    _cal.spinner().style.display = 'block';
    _cal.indeterminate().style.display = 'none';

    _cal.stepLabel().textContent = label;
    _cal.stepLabel().style.display = 'block';

    if (desc) {
        _cal.stepDesc().textContent = desc;
        _cal.stepDesc().style.display = 'block';
    }

    if (progress !== null) {
        _cal.progressFill().style.width = Math.min(100, Math.max(0, progress)) + '%';
        _cal.stepCounter().textContent = (step !== null && totalSteps !== null)
            ? `Шаг ${step} / ${totalSteps}` : '';
        _cal.itemCounter().textContent = `${Math.round(progress)}%`;
        _cal.progressWrap().style.display = 'block';
    }
}

/* Обновить только прогресс без пересоздания оверлея */
function calUpdateProgress({ label, desc, step, totalSteps, progress, itemCurrent, itemTotal } = {}) {
    if (label) _cal.stepLabel().textContent = label;
    if (desc)  _cal.stepDesc().textContent  = desc;
    if (progress !== null && progress !== undefined)
        _cal.progressFill().style.width = Math.min(100, Math.max(0, progress)) + '%';
    if (step && totalSteps)
        _cal.stepCounter().textContent = `Шаг ${step} / ${totalSteps}`;
    if (itemCurrent !== undefined && itemTotal !== undefined)
        _cal.itemCounter().textContent = `${itemCurrent} / ${itemTotal}`;
    else if (progress !== null && progress !== undefined)
        _cal.itemCounter().textContent = `${Math.round(progress)}%`;
}

/* Шаг без прогресса — бегущая полоска */
function calShowIndeterminate({ label, desc = '' } = {}) {
    calShow();
    _cal.spinner().style.display       = 'none';
    _cal.indeterminate().style.display = 'block';

    _cal.stepLabel().textContent = label;
    _cal.stepLabel().style.display = 'block';

    if (desc) {
        _cal.stepDesc().textContent = desc;
        _cal.stepDesc().style.display = 'block';
    }
}

/* Успешное завершение */
function calShowSuccess({ title = 'Калибровка завершена', desc = '' } = {}) {
    _calReset();
    _cal.overlay().style.display = 'flex';
    _cal.spinner().style.display = 'none';

    _cal.resultIcon().classList.add('ok');
    _cal.resultIcon().textContent = '✓';
    _cal.resultIcon().style.display = 'flex';

    _cal.resultTitle().textContent = title;
    _cal.resultTitle().classList.add('ok');
    _cal.resultTitle().style.display = 'block';

    if (desc) {
        _cal.resultDesc().textContent = desc;
        _cal.resultDesc().style.display = 'block';
    }

    _cal.dismissBtn().textContent = 'Готово';
    _cal.dismissBtn().className   = 'btn btn-accent';
    _cal.dismissBtn().style.display = 'block';
}

/* Ошибка */
function calShowError({ title = 'Ошибка калибровки', desc = '' } = {}) {
    _calReset();
    _cal.overlay().style.display = 'flex';
    _cal.spinner().style.display = 'none';

    _cal.resultIcon().classList.add('err');
    _cal.resultIcon().textContent = '✕';
    _cal.resultIcon().style.display = 'flex';

    _cal.resultTitle().textContent = title;
    _cal.resultTitle().classList.add('err');
    _cal.resultTitle().style.display = 'block';

    if (desc) {
        _cal.resultDesc().textContent = desc;
        _cal.resultDesc().style.display = 'block';
    }

    _cal.dismissBtn().textContent = 'Закрыть';
    _cal.dismissBtn().className   = 'btn btn-ghost';
    _cal.dismissBtn().style.display = 'block';
}

// Навигация
function navigateTo(page) {
    document.querySelectorAll('.main-layout').forEach(el => el.style.display = 'none');
    document.getElementById(`page-${page}`).style.display = 'grid';

    document.querySelectorAll('.nav-step').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-step[data-step="${page}"]`).classList.add('active');

    if (page === 1) moveVideoTo('videoWrapper');
    //if (page === 2) moveVideoTo('videoWrapper2');

    syncNoSignal();
}

// Назначить на шаги навбара
document.querySelectorAll('.nav-step').forEach(el => {
    el.addEventListener('click', () => navigateTo(+el.dataset.step));
});

function showDistortionControls() {
    document.getElementById('distortionBody').classList.add('visible');
}

function hideDistortionControls() {
    document.getElementById('distortionBody').classList.remove('visible');
}

function requestDistortionCompute() {
    sendWS({
        type: 'undistort_compute',
        client_id: state.clientId,
        meta: {
            alpha: Number(UNDIST_SLIDERS["alpha"].value().textContent),
            zoom: Number(UNDIST_SLIDERS["zoom"].value().textContent),
            shift_x: Number(UNDIST_SLIDERS["shiftX"].value().textContent),
            shift_y: Number(UNDIST_SLIDERS["shiftY"].value().textContent),
        }
    });
}

function handleDistortionCompute(msg) {
    if (!msg.ret) {
        let err_text = `Ошибка при вычислении коррекции искажений: ${msg.meta?.description ?? 'нет описания ошибки'}`;
        log(err_text, 'err');
        showToast("Ошибка", err_text, 'err');
        return;
    }

    setDistortionState("success");
    showPanelBlock(dom.correctionBlock.id);
}

function onDistortionDisplayToggle() {
    let desired = undist.show.checked;
    undist.show.checked = !desired;       // откатить визуально до ответа сервера

    sendWS({
        type:        'view_undistort',
        client_id:   state.clientId,
        meta: {
            "show" : desired,
        },
    })
}

function handleOnDistortionShow(msg) {
    if (!msg.ret) {
        log(`Ошибка при отображении коррекции изображений: ${msg.meta?.description ?? 'нет описания ошибки'}`);
        return;
    }

    let show = msg.meta?.show ?? false;
    undist.show.checked = show;
    log(`Изменено отображение коррекции`, 'info');
}

function _fmt(n, decimals = 2) {
    return parseFloat(n).toFixed(decimals);
}

function onSliderInput(key, rawValue) {
    const s = UNDIST_SLIDERS[key];
    if (!s) return;
    s.value().textContent = _fmt(rawValue);
}

function onSliderCommit(key, rawValue) {
    const value = parseFloat(rawValue);
    console.log(`slider commit [${key}]:`, value);
    // сюда вставить отправку на сервер / применение
}

function setSliderConfig(key, { value, min, max, mid, decimals = 2 } = {}) {
    const s = UNDIST_SLIDERS[key];
    if (!s) return;

    const midVal = mid ?? (min + max) / 2;

    s.slider().min   = min;
    s.slider().max   = max;
    s.slider().value = value;

    s.min().textContent   = _fmt(min,    decimals);
    s.mid().textContent   = _fmt(midVal, decimals);
    s.max().textContent   = _fmt(max,    decimals);
    s.value().textContent = _fmt(value,  decimals);
}

// ════════════════════════════════════════════════════════════
// Работа с конфигурауциями
// ════════════════════════════════════════════════════════════

function openLoadConfigModal(configs = []) {
    _selectedConfigId = null;

    config.list.innerHTML = '';

    /*configs.forEach(cfg => {
        const item = document.createElement('div');
        item.className = 'config-list-item';
        item.dataset.id = cfg.id;
        item.innerHTML = `
            <span class="config-item-name">${cfg.name}</span>
            <span class="config-item-sub">${cfg.sub ?? cfg.id}</span>
        `;
        item.onclick = () => selectConfig(cfg, item);
        list.appendChild(item);
    });*/
    config.detail.style.display = 'none';
    config.modal.style.display = 'flex';
}

function closeLoadConfigModal(e) {
    if (e && e.target !== config.modal) return;
    config.modal.style.display = 'none';
}

// ════════════════════════════════════════════════════════════
// BINARY MESSAGES (формат: 4 байта big-endian JSON size + JSON + бинарные данные)
// ════════════════════════════════════════════════════════════

function handleBinaryMessage(buffer) {
    const view     = new DataView(buffer);
    const jsonSize = (view.getUint8(0) << 24) | (view.getUint8(1) << 16) |
        (view.getUint8(2) << 8)  |  view.getUint8(3);

    const jsonBytes  = new Uint8Array(buffer, 4, jsonSize);
    const imageBytes = new Uint8Array(buffer, 4 + jsonSize);

    let msg = {};
    try { msg = JSON.parse(new TextDecoder().decode(jsonBytes)); } catch {}

    msg._imageBytes = imageBytes;  // прокидываем байты вместе с msg
    dispatchServerMessage(msg);
}

// ════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════

function showPanelBlock(id) {
    document.getElementById(id).classList.add('visible');
    document.getElementById(id).classList.remove('panel-block--hidden');
}

function hidePanelBlock(id) {
    document.getElementById(id).classList.remove('visible');
    document.getElementById(id).classList.add('panel-block--hidden');
}

function toggleFullscreen() {
    const el = document.getElementById('videoWrapper');
    if (!document.fullscreenElement) {
        el.requestFullscreen?.();
    } else {
        document.exitFullscreen?.();
    }
}

// Cleanup on page close
window.addEventListener('beforeunload', () => {
    closeRTC();
    if (state.ws) state.ws.close();
});

let _toastTimer = null;

function showToast(title, desc, type = 'info') {
    const toast    = document.getElementById('toast');
    const icon     = document.getElementById('toastIcon');
    const progress = document.getElementById('toastProgress');

    const icons = { ok: '✓', err: '✕', info: '◈' };

    toast.className      = `toast ${type}`;
    icon.textContent     = icons[type] ?? icons.info;
    document.getElementById('toastTitle').textContent = title;
    document.getElementById('toastDesc').textContent  = desc;

    // сбросить прогресс-бар
    progress.className = 'toast-progress';
    void progress.offsetWidth; // reflow для рестарта анимации
    progress.classList.add('running');

    if (_toastTimer) clearTimeout(_toastTimer);

    requestAnimationFrame(() => toast.classList.add('visible'));

    _toastTimer = setTimeout(toastHide, 30_000);
}

function toastHide() {
    const toast = document.getElementById('toast');
    toast.classList.remove('visible');
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}