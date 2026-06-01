/**
 * linker/data.js — Загрузка данных с сервера
 *
 * Только REST-запросы и обновление state. Рендер — в setup-ui.js.
 */
'use strict';

import { fetchJson } from '../api/api.js';
import { log, showToast } from '../utils/utility.js';
import { linkerState } from '../core/linker-state.js';

export async function loadExports() {
    try {
        const json = await fetchJson('GET', '/linker/exports');
        linkerState.exports = json.data?.exports ?? json.exports ?? [];
        log(`Linker: loaded ${linkerState.exports.length} exports`, 'info');
    } catch (e) {
        log(`Linker: loadExports failed: ${e.message}`, 'err');
        showToast('Не удалось загрузить', e.message, 'err');
    }
}

export async function loadCameras() {
    try {
        const json = await fetchJson('GET', '/api/camera');
        const all  = json.data?.cameras ?? {};
        linkerState.cameras = Object.entries(all)
            .filter(([, c]) => c.type === 3)
            .map(([id, c]) => ({ id, display_name: c.display_name ?? id }));
        log(`Linker: loaded ${linkerState.cameras.length} cameras (type=3)`, 'info');
    } catch (e) {
        log(`Linker: loadCameras failed: ${e.message}`, 'err');
        showToast('Не удалось получить камеры', e.message, 'err');
    }
}

export async function loadStatus() {
    try {
        const json = await fetchJson('GET', '/linker/status');
        const data = json.data ?? json;
        linkerState.streaming = !!data.running;
        linkerState.streamId  = data.stream_id ?? null;
        log(`Linker status: running=${linkerState.streaming}, streamId=${linkerState.streamId}`);
    } catch (e) {
        log(`Linker: status failed: ${e.message}`, 'warn');
    }
}

export async function loadExportState(exportId) {
    try {
        const json = await fetchJson('GET', '/linker/state');
        const st   = json.data ?? json;
        if (st.export_id === exportId && st.cameras) {
            return { ...st.cameras };
        }
    } catch (_) {
        // нет state — нормально
    }
    return {};
}

export async function saveStateAndStart(exportId, bindings) {
    await fetchJson('POST', '/linker/state', {
        export_id: exportId,
        cameras:   bindings,
    });
    log(`Linker: state saved for <${exportId}>`, 'info');

    await fetchJson('POST', '/linker/start');
    linkerState.streaming = true;
    log('Linker: started!', 'info');
}

export async function stopLinker() {
    await fetchJson('POST', '/linker/stop');
    linkerState.streaming = false;
}