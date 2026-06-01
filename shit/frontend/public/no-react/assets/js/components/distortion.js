/**
 * birdview/distortion.js — Коррекция искажений: слайдеры, panorama
 */
'use strict';

import { state } from '../core/state.js';
import { sendWS } from '../core/websocket.js';
import { log, showToast } from '../utils/utility.js';
import { setUndistortionState, showPanelBlock, enableSaveButton } from '../ui/status.js';

const undist = {
    show:          document.getElementById('distortionDisplayToggle'),
    panorama:      document.getElementById('panoramaToggle'),
    panoramaBlock: document.getElementById('panoramaRadiusBlock'),
    alphaSlider:   document.getElementById('distAlphaSlider'),
    zoomSlider:    document.getElementById('distZoomSlider'),
    shiftXSlider:  document.getElementById('distShiftXSlider'),
    shiftYSlider:  document.getElementById('distShiftYSlider'),
    k1Slider:      document.getElementById('distK1Slider'),
    k2Slider:      document.getElementById('distK2Slider'),
    k3Slider:      document.getElementById('distK3Slider'),
    k4Slider:      document.getElementById('distK4Slider'),
};

const UNDIST_SLIDERS = {
    alpha:   { value: () => document.getElementById('distAlphaValue'),  min: () => document.getElementById('distAlphaMin'),  mid: () => document.getElementById('distAlphaMid'),  max: () => document.getElementById('distAlphaMax'),  slider: () => undist.alphaSlider,  decimals: 3 },
    zoom:    { value: () => document.getElementById('distZoomValue'),   min: () => document.getElementById('distZoomMin'),   mid: () => document.getElementById('distZoomMid'),   max: () => document.getElementById('distZoomMax'),   slider: () => undist.zoomSlider,   decimals: 3 },
    shift_x: { value: () => document.getElementById('distShiftXValue'), min: () => document.getElementById('distShiftXMin'), mid: () => document.getElementById('distShiftXMid'), max: () => document.getElementById('distShiftXMax'), slider: () => undist.shiftXSlider, decimals: 0 },
    shift_y: { value: () => document.getElementById('distShiftYValue'), min: () => document.getElementById('distShiftYMin'), mid: () => document.getElementById('distShiftYMid'), max: () => document.getElementById('distShiftYMax'), slider: () => undist.shiftYSlider, decimals: 0 },
    k1:      { value: () => document.getElementById('distK1Value'), min: () => document.getElementById('distK1Min'), mid: () => document.getElementById('distK1Mid'), max: () => document.getElementById('distK1Max'), slider: () => undist.k1Slider, decimals: 4 },
    k2:      { value: () => document.getElementById('distK2Value'), min: () => document.getElementById('distK2Min'), mid: () => document.getElementById('distK2Mid'), max: () => document.getElementById('distK2Max'), slider: () => undist.k2Slider, decimals: 4 },
    k3:      { value: () => document.getElementById('distK3Value'), min: () => document.getElementById('distK3Min'), mid: () => document.getElementById('distK3Mid'), max: () => document.getElementById('distK3Max'), slider: () => undist.k3Slider, decimals: 4 },
    k4:      { value: () => document.getElementById('distK4Value'), min: () => document.getElementById('distK4Min'), mid: () => document.getElementById('distK4Mid'), max: () => document.getElementById('distK4Max'), slider: () => undist.k4Slider, decimals: 4 },
    radius:  { value: () => document.getElementById('distRadiusValue'), min: () => document.getElementById('distRadiusMin'), mid: () => document.getElementById('distRadiusMid'), max: () => document.getElementById('distRadiusMax'), slider: () => document.getElementById('distRadiusSlider'), decimals: 0 },
};

function _fmt(n, d = 2) { return parseFloat(n).toFixed(d); }

export function syncSlider(key, value) {
    const s = UNDIST_SLIDERS[key]; if (!s) return;
    s.slider().value = value;
    s.value().textContent = _fmt(value, s.decimals);
}

export function setSliderConfig(key, { value, min, max, mid, decimals = 2 } = {}) {
    const s = UNDIST_SLIDERS[key]; if (!s) return;
    const midVal = mid ?? (min + max) / 2;
    s.slider().min = min; s.slider().max = max; s.slider().value = value;
    s.min().textContent = _fmt(min, decimals);
    s.mid().textContent = _fmt(midVal, decimals);
    s.max().textContent = _fmt(max, decimals);
    s.value().textContent = _fmt(value, decimals);
}

export function onSliderInput(key, rawValue) {
    const s = UNDIST_SLIDERS[key]; if (!s) return;
    s.value().textContent = _fmt(rawValue, s.decimals);
}

export function onSliderCommit(key, rawValue) {
    if (key === 'radius') {
        sendWS({ type: 'compute_panorama_remap', client_id: state.clientId, meta: { radius: Math.round(parseFloat(rawValue)) } });
        return;
    }
    requestDistortionCompute(true);
}

export function showDistortionControls() { document.getElementById('distortionBody')?.classList.add('visible'); }
export function hideDistortionControls() { document.getElementById('distortionBody')?.classList.remove('visible'); }

export function requestDistortionCompute(use_k) {
    sendWS({
        type: 'undistort_compute', client_id: state.clientId,
        meta: {
            alpha: Number(undist.alphaSlider?.value), zoom: Number(undist.zoomSlider?.value),
            shift_x: Number(undist.shiftXSlider?.value), shift_y: Number(undist.shiftYSlider?.value),
            ...(use_k ? { k1: Number(undist.k1Slider?.value), k2: Number(undist.k2Slider?.value), k3: Number(undist.k3Slider?.value), k4: Number(undist.k4Slider?.value) } : {}),
        },
    });
}

export function handleDistortionCompute(msg) {
    if (!msg.ret) { showToast('Ошибка', msg.meta?.description ?? '', 'err'); return; }
    if (msg.meta) {
        for (const key in msg.meta) {
            if (key in UNDIST_SLIDERS) syncSlider(key, Number(msg.meta[key]));
        }
        setUndistortionState('success');
        showPanelBlock('correctionBlock');
        enableSaveButton();
    }
}

export function onDistortionDisplayToggle() {
    const desired = undist.show.checked;
    undist.show.checked = !desired;
    sendWS({ type: 'view_undistort', client_id: state.clientId, meta: { show: desired } });
}

export function handleOnDistortionShow(msg) {
    if (!msg.ret) { requestDistortionCompute(false); return; }
    undist.show.checked = msg.meta?.show ?? false;
}

export function onPanoramaToggle() {
    const desired = undist.panorama.checked;
    undist.panorama.checked = !desired;
    sendWS({ type: 'panorama_toggle', client_id: state.clientId, meta: { use_panorama_remap: desired } });
}

export function handleOnPanoramaToggle(msg) {
    if (!msg.ret) { log(`Панорама: ${msg.meta?.description ?? ''}`, 'err'); return; }
    const use = msg.meta?.use_panorama_remap ?? false;
    undist.panorama.checked = use;
    if (use) {
        const maxR = Math.max(1, Math.floor((msg.meta?.height ?? 2) / 2));
        setSliderConfig('radius', { value: maxR, min: 1, max: maxR, decimals: 0 });
        if (undist.panoramaBlock) undist.panoramaBlock.style.display = 'flex';
    } else {
        if (undist.panoramaBlock) undist.panoramaBlock.style.display = 'none';
        requestDistortionCompute(false);
    }
}