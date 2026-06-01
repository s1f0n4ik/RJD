/**
 * utility/utility.js — Логирование и toast-уведомления
 *
 * Используется всеми страницами. Привязан к DOM-элементам
 * #eventLog, #toast и дочерним.
 */
'use strict';

let _toastTimer = null;

const eventLog = document.getElementById('eventLog');

// ════════════════════════════════════════════════════════════
// LOGGING
// ════════════════════════════════════════════════════════════

export function log(msg, level = 'info', data = null) {
    const prefix = `[${level.toUpperCase()}]`;
    data !== null ? console.log(prefix, msg, data) : console.log(prefix, msg);

    if (!eventLog) return;

    const now  = new Date();
    const time = now.toTimeString().slice(0, 8);
    const text = data !== null
        ? `${msg}\n${JSON.stringify(data, null, 2)}`
        : msg;

    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-msg">${text}</span>
    `;

    eventLog.appendChild(entry);
    eventLog.scrollTop = eventLog.scrollHeight;
}

export function clearLog() {
    if (eventLog) eventLog.innerHTML = '';
}

// ════════════════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════════════════

export function showToast(title, desc, type = 'info') {
    const toast    = document.getElementById('toast');
    const icon     = document.getElementById('toastIcon');
    const progress = document.getElementById('toastProgress');

    if (!toast) return;

    const icons = { ok: '✓', err: '✕', info: '◈' };

    toast.className  = `toast ${type}`;
    icon.textContent = icons[type] ?? icons.info;
    document.getElementById('toastTitle').textContent = title;
    document.getElementById('toastDesc').textContent  = desc;

    progress.className = 'toast-progress';
    void progress.offsetWidth;
    progress.classList.add('running');

    if (_toastTimer) clearTimeout(_toastTimer);
    requestAnimationFrame(() => toast.classList.add('visible'));
    _toastTimer = setTimeout(toastHide, 30_000);
}

export function toastHide() {
    const toast = document.getElementById('toast');
    if (toast) toast.classList.remove('visible');
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}

Object.assign(window, { toastHide, clearLog });