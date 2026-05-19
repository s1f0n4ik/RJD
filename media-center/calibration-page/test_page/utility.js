let _toastTimer = null;

const eventLog = document.getElementById('eventLog');

// ════════════════════════════════════════════════════════════
// LOGGING
// ════════════════════════════════════════════════════════════

export function log(msg, level = 'info', data = null) {
    const prefix = `[${level.toUpperCase()}]`;

    if (data !== null) {
        console.log(prefix, msg, data);
    }
    else {
        console.log(prefix, msg);
    }

    const now = new Date();
    const time = now.toTimeString().slice(0, 8);

    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;

    const text = data !== null
        ? `${msg}\n${JSON.stringify(data, null, 2)}`
        : msg;

    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-msg">${text}</span>
    `;

    eventLog.appendChild(entry);
    eventLog.scrollTop = eventLog.scrollHeight;
}

export function clearLog() {
    eventLog.innerHTML = '';
}

export function showToast(title, desc, type = 'info') {
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

export function toastHide() {
    const toast = document.getElementById('toast');
    toast.classList.remove('visible');
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}

Object.assign(window, {
    toastHide,
    clearLog
});