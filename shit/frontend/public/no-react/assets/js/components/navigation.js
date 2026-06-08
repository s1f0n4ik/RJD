/**
 * birdview/navigation.js — Навигация между страницами
 */
'use strict';

import { state } from '../core/state.js';
import { showToast } from '../utils/utility.js';
import { syncNoSignal } from '../ui/status.js';
import { initProjPage } from '../pages/projection.js';
import { initLinkerPage } from '../pages/linker.js';
import { initConfiguratorPage } from '../pages/configurator.js';

export function moveVideoTo(wrapperId) {
    const video   = document.getElementById('remoteVideo');
    const wrapper = document.getElementById(wrapperId);
    if (video && wrapper) wrapper.appendChild(video);
}

export function goToAdmin() {
    window.location.href = '/';
}

export function navigateTo(page) {
    if (page === 2) {
        if (!state.camera) { showToast('Камера не выбрана', 'Выберите камеру', 'err'); return; }
    }

    document.querySelectorAll('.main-layout').forEach(el => el.style.display = 'none');
    document.getElementById(`page-${page}`).style.display = 'grid';

    document.querySelectorAll('.nav-step').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-step[data-step="${page}"]`)?.classList.add('active');

    if (page === 1) moveVideoTo('videoWrapper');
    if (page === 2) { moveVideoTo('uiCanvasLayer'); initProjPage(); }
    if (page === 3) initLinkerPage();
    if (page === 4) initConfiguratorPage();

    syncNoSignal();
}

document.querySelectorAll('.nav-step').forEach(el => {
    el.addEventListener('click', () => navigateTo(+el.dataset.step));
});

Object.assign(window, {
    goToAdmin,
});