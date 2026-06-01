/**
 * birdview/app.js — Точка входа BirdView.
 *
 * WebRTC-подключение калибровочного стрима через core/webrtc.js.
 * Никакого дублирующего RTCPeerConnection — один модуль, одна точка входа.
 */
'use strict';

import { state } from '../core/state.js';
import { log } from '../utils/utility.js';
import {
    createWebRTCSession, connectWebRTC, closeWebRTC, wsUrl,
} from '../core/webrtc.js';
import {
    sendWS, sendWSMessage, connectWS, disconnectWS,
    setOnMessage, setOnClose,
} from '../core/websocket.js';
import {
    setRtcWsStatus, setRtcStatus,
    setIceState, setConnState,
    setStreamIdTag, setFrameInfo,
    setStreamingUI, showVideo, hideVideo,
    hidePanelBlock, disableSaveButton,
    toggleFullscreen,
} from '../ui/status.js';
import { toggleCameraSelect } from '../components/camera.js';
import {
    handleAddImageResponse, handleRemoveSnapshot,
    handleSnapshotFrame, handleChessboardResponse,
    handleCalibrationStatus, handleGetCalibrationPattern,
    handleStartCalibration, handleCalibrateStep,
    handleReprojectionError, handleCalibrationCompute,
    handleCalibrationResult,
    calHide, resumeStream, toggleSnapshotDrawer,
    requestClearSnapshotList, clearSnapshotList,
} from '../components/calibration.js';
import {
    handleDistortionCompute, handleOnDistortionShow,
    handleOnPanoramaToggle,
    onSliderInput, onSliderCommit,
    onDistortionDisplayToggle, onPanoramaToggle,
} from '../components/distortion.js';
import {
    requestListOfCalibrationConfigurations,
    closeLoadConfigModal, requestLoadSelectedConfig,
    saveCalibrationConfiguration, handleCalibrationConfiguration,
} from '../components/config.js';
import { handleProjectionMessage } from '../api/proj-server.js';
import '../components/navigation.js';

// ════════════════════════════════════════════════════════════
// WebRTC-сессия калибровки (единственная, через core/webrtc.js)
// ════════════════════════════════════════════════════════════

const calRtc = createWebRTCSession();

// ════════════════════════════════════════════════════════════
// MESSAGE DISPATCH (основной WS)
// ════════════════════════════════════════════════════════════

setOnMessage(dispatchServerMessage);

setOnClose(() => {
    setStreamingUI(false);
    hidePanelBlock('calibrationBlock');
    hidePanelBlock('correctionBlock');
    disableSaveButton();
});

function dispatchServerMessage(msg) {
    if (!msg.ret && msg.meta?.description)
        log(`Сервер: ошибка — ${msg.meta.description}`, 'err');

    switch (msg.type) {
        case 'connection':                handleConnectionResponse(msg);       break;
        case 'add_image':                 handleAddImageResponse(msg);         break;
        case 'delete_image':              handleRemoveSnapshot(msg);           break;
        case 'get_image':                 handleSnapshotFrame(msg);            break;
        case 'chessboard':                handleChessboardResponse(msg);       break;
        case 'status':                    handleCalibrationStatus(msg);        break;
        case 'get_pattern':               handleGetCalibrationPattern(msg);    break;
        case 'calibration_start':         handleStartCalibration(msg);         break;
        case 'calibration_progress':      handleCalibrateStep(msg);            break;
        case 'calibration_post_process':  handleReprojectionError(msg);        break;
        case 'calibration_compute':       handleCalibrationCompute(msg);       break;
        case 'calibration_result':        handleCalibrationResult(msg);        break;
        case 'undistort_compute':         handleDistortionCompute(msg);        break;
        case 'view_undistort':            handleOnDistortionShow(msg);         break;
        case 'panorama_toggle':           handleOnPanoramaToggle(msg);         break;
        case 'calibration_configuration': handleCalibrationConfiguration(msg); break;
        case 'projection_configuration':  handleProjectionMessage(msg);        break;
        default: log(`Неизвестный тип: ${msg.type}`, 'warn');
    }
}

// ════════════════════════════════════════════════════════════
// CONNECTION → WebRTC через core/webrtc.js
// ════════════════════════════════════════════════════════════

function handleConnectionResponse(msg) {
    if (!msg.ret) return;

    state.streamId = msg.meta?.id_stream ?? null;
    if (!state.streamId) {
        log('Ошибка: сервер не вернул id_stream', 'err');
        return;
    }

    setStreamIdTag(`stream: ${state.streamId}`);
    log(`Стрим запущен: ${state.streamId}`, 'ok');
    log('Инициируем WebRTC через core/webrtc.js...', 'ok');

    setRtcStatus('connecting');

    connectWebRTC(calRtc, {
        streamId: state.streamId,
        clientId: state.clientId,
        wsUrl:    wsUrl(`/signaling/client/${state.streamId}`),

        // ── Сигналинг WS ────────────────────────────────
        onWsOpen: () => {
            setRtcWsStatus('connected');
            log('RTC WebSocket подключён', 'ok');
            // Запрос статуса калибровки по основному WS
            sendWS({ type: 'status', client_id: state.clientId, meta: {} });
        },

        onWsClose: () => {
            setRtcWsStatus('disconnected');
            log('RTC WebSocket закрыт', 'warn');
            hidePanelBlock('calibrationBlock');
            hidePanelBlock('correctionBlock');
            disableSaveButton();
            hideVideo();
        },

        // ── Peer Connection готов ────────────────────────
        onReady: () => {
            log('RTCPeerConnection создан', 'ok');
        },

        // ── Медиапоток ──────────────────────────────────
        onTrack: (e) => {
            log('Медиапоток получен', 'ok');
            const video = document.getElementById('remoteVideo');
            if (video) video.srcObject = e.streams[0];
            showVideo();
            setFrameInfo(`${e.streams[0].id.slice(0, 8)}...`);
        },

        // ── ICE state ───────────────────────────────────
        onIceStateChange: (s) => {
            log(`ICE state: ${s}`);
            setIceState(s);
        },

        // ── Connection state ────────────────────────────
        onConnectionStateChange: (s) => {
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
        },

        // ── Ошибки ──────────────────────────────────────
        onError: (e) => {
            log('WebRTC ошибка: ' + e, 'err');
            setRtcWsStatus('disconnected');
        },

        // ── Закрытие сессии ─────────────────────────────
        onClose: () => {
            setRtcStatus('disconnected');
            setRtcWsStatus('disconnected');
            setIceState('—');
            setConnState('—');
            clearSnapshotList();
            const check = document.getElementById('chessboardToggle');
            if (check) check.checked = false;
            log('WebRTC сессия закрыта', 'warn');
        },
    });
}

// ════════════════════════════════════════════════════════════
// STREAM CONTROL
// ════════════════════════════════════════════════════════════

function startCalibrationStream() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        log('Сначала подключитесь к WebSocket', 'warn');
        return;
    }
    if (!state.camera) {
        log('Камера не выбрана!');
        return;
    }

    const { id: camera_id, width, height, fps } = state.camera;
    log(`Запрос стрима: ${camera_id} @ ${width}×${height} / ${fps}fps`);
    sendWS({
        type:      'connection',
        client_id: state.clientId,
        meta:      { camera_id, width: parseInt(width), height: parseInt(height), fps: parseInt(fps) },
    });
}

function toggleStream() {
    if (calRtc.pc) {
        // Закрываем через core/webrtc.js
        closeWebRTC(calRtc);
        sendWS({
            type: 'close', client_id: state.clientId,
            camera: state.streamId,
            meta: { description: `close from ${state.clientId}` },
            ret: 'none',
        });
        setStreamingUI(false);
        hideVideo();
    } else {
        startCalibrationStream();
    }
}

// ════════════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════════════

window.addEventListener('beforeunload', () => {
    closeWebRTC(calRtc);
    if (state.ws) state.ws.close();
});

// ════════════════════════════════════════════════════════════
// GLOBAL BINDINGS (onclick из HTML)
// ════════════════════════════════════════════════════════════

Object.assign(window, {
    connectWS,
    disconnectWS,
    toggleCameraSelect,
    toggleStream,
    requestListOfCalibrationConfigurations,
    closeLoadConfigModal,
    requestLoadSelectedConfig,
    saveCalibrationConfiguration,
    onSliderInput,
    onSliderCommit,
    onDistortionDisplayToggle,
    onPanoramaToggle,
    calHide,
    toggleFullscreen,
    resumeStream,
    toggleSnapshotDrawer,
    requestClearSnapshotList,
});