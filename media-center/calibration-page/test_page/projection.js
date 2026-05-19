// ── Состояние ─────────────────────────────────────────────
import {showToast} from "./utility.js";

const projState = {
    settingsOpen: false,
    config:       4,           // 4 или 6 камер
    activeCam:    null,        // id выбранной камеры
    doneSet:      new Set(),   // id уже спроецированных камер
    points:       [],          // { x, y, id }
    maxPoints:    4,
    applied:      false,
    savedPoints:  [],
    // result canvas pan/zoom
    result:       { scale: 1, ox: 0, oy: 0, dragging: false, startX: 0, startY: 0 },
};

const PROJ_CAMERAS_4 = [
    { id: 'front',  label: 'Передняя' },
    { id: 'back',   label: 'Задняя'   },
    { id: 'left',   label: 'Левая'    },
    { id: 'right',  label: 'Правая'   },
];
const PROJ_CAMERAS_6 = [
    { id: 'front',          label: 'Передняя'       },
    { id: 'back',           label: 'Задняя'         },
    { id: 'back-left',      label: 'Левая сзади'    },
    { id: 'back-right',     label: 'Правая сзади'   },
    { id: 'front-left',     label: 'Левая спереди'  },
    { id: 'front-right',    label: 'Правая сзади'   },
];

// ── Настройки ─────────────────────────────────────────────
function toggleProjSettings() {
    projState.settingsOpen = !projState.settingsOpen;
    document.getElementById('projSettingsDrawer').classList.toggle('open', projState.settingsOpen);
    document.getElementById('projSettingsTab').classList.toggle('open',    projState.settingsOpen);
    document.getElementById('projWarpArea').classList.toggle('shifted',    projState.settingsOpen);
}

function selectProjConfig(btn) {
    projState.config = +btn.dataset.config;
    document.querySelectorAll('.proj-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _renderProjCamList();
}

function _renderProjCamList() {
    const list = document.getElementById('projCamList');
    list.innerHTML = '';
    const cameras = projState.config === 6 ? PROJ_CAMERAS_6 : PROJ_CAMERAS_4;

    cameras.forEach(cam => {
        const el = document.createElement('div');
        el.className = 'proj-cam-item' + (projState.activeCam === cam.id ? ' active' : '');
        el.innerHTML = `
            <div class="proj-cam-radio"></div>
            <span class="proj-cam-name">${cam.label}</span>
            <div class="proj-cam-done ${projState.doneSet.has(cam.id) ? 'done' : ''}"></div>
        `;
        el.onclick = () => selectProjCamera(cam.id);
        list.appendChild(el);
    });
}

function selectProjCamera(id) {
    projState.activeCam = id;
    projClearPoints();
    _renderProjCamList();
}

// ── Warp canvas ───────────────────────────────────────────
let _projDraggingPoint = null;
let _projDragMoved     = false;
const DRAG_THRESHOLD   = 4; // px — минимальное смещение чтобы считать drag

function getNormalizedCanvasCoords(canvas, event) {
    const rect = canvas.getBoundingClientRect();

    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    return {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y))
    };
}

function initProjWarpCanvas() {
    const canvas  = document.getElementById('projWarpCanvas');
    const wrapper = document.getElementById('uiCanvasLayer');
    const video   = document.getElementById('remoteVideo');

    canvas.addEventListener('pointerdown', (e) => {
        const pos = getNormalizedCanvasCoords(canvas, e);
        console.log(pos.x, pos.y);
    });
    canvas.addEventListener('mousemove', _projMouseMove);
    canvas.addEventListener('mouseup',   _projMouseUp);

    function resizeCanvas() {
        // Если видео готово — берём его реальные пропорции
        const vw = video?.videoWidth;
        const vh = video?.videoHeight;

        if (vw && vh) {
            const wrapperRatio  = wrapper.offsetWidth / wrapper.offsetHeight;
            const videoRatio    = vw / vh;
            let canvasW, canvasH;

            if (videoRatio > wrapperRatio) {
                canvasW = wrapper.offsetWidth;
                canvasH = Math.round(wrapper.offsetWidth / videoRatio);
            } else {
                canvasH = wrapper.offsetHeight;
                canvasW = Math.round(wrapper.offsetHeight * videoRatio);
            }

            canvas.width  = canvasW;
            canvas.height = canvasH;
            canvas.style.width  = canvasW + 'px';
            canvas.style.height = canvasH + 'px';
            // Центрировать canvas поверх видео
            canvas.style.position = 'absolute';
            canvas.style.left = Math.round((wrapper.offsetWidth  - canvasW) / 2) + 'px';
            canvas.style.top  = Math.round((wrapper.offsetHeight - canvasH) / 2) + 'px';
        } else {
            // Видео ещё не готово — canvas по размеру wrapper
            canvas.width  = wrapper.offsetWidth;
            canvas.height = wrapper.offsetHeight;
            canvas.style.width  = '';
            canvas.style.height = '';
            canvas.style.left   = '0';
            canvas.style.top    = '0';
        }

        _projDraw();
    }

    // При изменении размера wrapper
    new ResizeObserver(resizeCanvas).observe(wrapper);

    // Когда видео получило реальные размеры
    if (video) {
        video.addEventListener('loadedmetadata', resizeCanvas);
        // Если метаданные уже есть
        if (video.readyState >= 1) resizeCanvas();
    }
}

function _projCanvasXY(e) {
    const canvas = document.getElementById('projWarpCanvas');
    const rect   = canvas.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
    };
}

function _projHitPoint(x, y) {
    const HIT = 12;
    for (let i = projState.points.length - 1; i >= 0; i--) {
        const p = projState.points[i];
        if (Math.hypot(p.x - x, p.y - y) < HIT) return i;
    }
    return -1;
}

let _projDragStartX = 0;
let _projDragStartY = 0;

function _projMouseDown(e) {
    if (projState.applied) return;
    const { x, y } = _projCanvasXY(e);
    _projDragMoved     = false;
    _projDragStartX    = x;
    _projDragStartY    = y;
    _projDraggingPoint = _projHitPoint(x, y);
}

function _projMouseMove(e) {
    if (projState.applied) return;
    if (_projDraggingPoint === null) return;

    const { x, y } = _projCanvasXY(e);

    // Проверить порог — drag начинается только после смещения
    if (!_projDragMoved) {
        const dist = Math.hypot(x - _projDragStartX, y - _projDragStartY);
        if (dist < DRAG_THRESHOLD) return;
        _projDragMoved = true;
    }

    projState.points[_projDraggingPoint].x = x;
    projState.points[_projDraggingPoint].y = y;
    _projDraw();
}

function _projMouseUp(e) {
    if (projState.applied) return;

    const wasDragging      = _projDraggingPoint !== null;
    const wasDragMove      = _projDragMoved;

    _projDraggingPoint = null;
    _projDragMoved     = false;

    // Клик: не было drag и не тащили существующую точку
    if (!wasDragMove && !wasDragging) {
        if (projState.points.length >= projState.maxPoints) return;
        const { x, y } = _projCanvasXY(e);
        projState.points.push({ x, y, id: Date.now() });
        _projDraw();
        _projUpdateUI();
    }
}

function _projDraw() {
    const canvas = document.getElementById('projWarpCanvas');
    const ctx    = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pts = projState.points;
    if (!pts.length) return;

    // Линии
    if (pts.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(200,255,64,0.4)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 4]);
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        if (pts.length === projState.maxPoints) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
    }

    const R = 7; // радиус точки

    pts.forEach((p, i) => {
        // Внешнее кольцо
        ctx.beginPath();
        ctx.arc(p.x, p.y, R + 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();

        // Заливка
        ctx.beginPath();
        ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
        ctx.fillStyle   = '#c8ff40';
        ctx.strokeStyle = '#0a0a0c';
        ctx.lineWidth   = 1.5;
        ctx.fill();
        ctx.stroke();

        // Номер — справа от точки, с тёмной подложкой
        const label  = String(i + 1);
        const lx     = p.x + R + 6;
        const ly     = p.y;
        const pad    = 3;
        ctx.font     = 'bold 11px monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;

        ctx.fillStyle    = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(lx - pad, ly - 8, tw + pad * 2, 16, 3);
        ctx.fill();

        ctx.fillStyle = '#c8ff40';
        ctx.fillText(label, lx, ly);
    });
}

function _projUpdateUI() {
    const n = projState.points.length;
    document.getElementById('projPointBadge').textContent = `${n} / ${projState.maxPoints}`;
}

function projRemoveLastPoint() {
    projState.points.pop();
    _projDraw();
    _projUpdateUI();
}

function projClearPoints() {
    projState.points  = [];
    projState.applied = false;
    document.getElementById('projWarpWrapper').classList.remove('applied');
    document.getElementById('projApplyBtn').textContent = '⊛ Применить warp';
    document.getElementById('projEditState').textContent = 'Режим: редактирование';
    _projDraw();
    _projUpdateUI();
}

function projToggleApply() {
    if (projState.applied) {
        // Вернуть точки
        projState.points  = [...projState.savedPoints];
        projState.applied = false;
        document.getElementById('projWarpWrapper').classList.remove('applied');
        document.getElementById('projApplyBtn').textContent = '⊛ Применить warp';
        document.getElementById('projEditState').textContent = 'Режим: редактирование';
        _projDraw();
    } else {
        if (projState.points.length < projState.maxPoints) {
            showToast('Недостаточно точек', `Необходимо ${projState.maxPoints} точки`, 'err');
            return;
        }
        if (!projState.activeCam) {
            showToast('Камера не выбрана', 'Выберите камеру в настройках', 'err');
            return;
        }

        projState.savedPoints = [...projState.points];
        projState.applied     = true;

        document.getElementById('projWarpWrapper').classList.add('applied');
        document.getElementById('projApplyBtn').textContent = '↩ Редактировать';
        document.getElementById('projEditState').textContent = 'Режим: просмотр';

        const canvas = document.getElementById('projWarpCanvas');
        const W = canvas.width, H = canvas.height;
        const normPoints = projState.points.map(p => ({
            x: +(p.x / W).toFixed(4),
            y: +(p.y / H).toFixed(4),
        }));

        sendWS({
            type:      'apply_warp',
            client_id: state.clientId,
            camera:    projState.activeCam,
            meta:      { points: normPoints },
        });

        projState.doneSet.add(projState.activeCam);
        _renderProjCamList();

        // Очистить canvas после применения
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
    }
}

// ── Result canvas: pan + zoom ─────────────────────────────
function projResultZoom(e) {
    e.preventDefault();
    const r = projState.result;
    r.scale = Math.min(8, Math.max(0.25, r.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    _applyResultTransform();
}

function projResultDragStart(e) {
    const r = projState.result;
    r.dragging = true;
    r.startX   = e.clientX - r.ox;
    r.startY   = e.clientY - r.oy;
}

function projResultDragMove(e) {
    const r = projState.result;
    if (!r.dragging) return;
    r.ox = e.clientX - r.startX;
    r.oy = e.clientY - r.startY;
    _applyResultTransform();
}

function projResultDragEnd() { projState.result.dragging = false; }

function _applyResultTransform() {
    const { scale, ox, oy } = projState.result;
    const canvas = document.querySelector('#projResultImg');
    if (canvas) canvas.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
}

// Вызвать когда по WS пришло изображение результата (ImageBitmap или blob)
function projSetResultImage(imageBitmap) {
    const canvas = document.getElementById('projResultImg');
    canvas.width  = imageBitmap.width;
    canvas.height = imageBitmap.height;
    canvas.getContext('2d').drawImage(imageBitmap, 0, 0);
    document.getElementById('noSignalResult').classList.add('hidden');
}

// ── LUT ───────────────────────────────────────────────────
function projCalculateLUT() {
    sendWS({
        type:      'calculate_lut',
        client_id: state.clientId,
        meta:      {},
    });
}

// ── Джойстик ─────────────────────────────────────────────
(function initProjJoystick() {
    const nub     = document.getElementById('projJoyNub');
    const joy     = document.getElementById('projJoystick');
    const MAX_R   = 30;
    let dragging  = false;
    let lastSend  = 0;
    const THROTTLE = 80; // ms

    nub.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });

    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const jr = joy.getBoundingClientRect();
        const cx = jr.left + jr.width  / 2;
        const cy = jr.top  + jr.height / 2;
        let dx = e.clientX - cx;
        let dy = e.clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > MAX_R) { dx = dx / dist * MAX_R; dy = dy / dist * MAX_R; }

        nub.style.transform = `translate(${dx}px, ${dy}px)`;

        const now = Date.now();
        if (now - lastSend > THROTTLE) {
            lastSend = now;
            sendWS({
                type:      'projection_shift',
                client_id: state.clientId,
                meta: {
                    dx: +(dx / MAX_R).toFixed(3),
                    dy: +(dy / MAX_R).toFixed(3),
                },
            });
        }
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        nub.style.transition = 'transform 0.2s';
        nub.style.transform  = 'translate(0,0)';
        setTimeout(() => nub.style.transition = '', 200);

        sendWS({
            type:      'projection_shift',
            client_id: state.clientId,
            meta:      { dx: 0, dy: 0 },
        });
    });
})();

// ── Инициализация страницы ────────────────────────────────
export function initProjPage() {
    const video   = document.getElementById('remoteVideo');
    const wrapper = document.getElementById('projWarpWrapper');

    if (video && !wrapper.contains(video)) {
        wrapper.insertBefore(video, wrapper.firstChild);
        if (video.srcObject) {
            video.classList.add('active');
            document.getElementById('noSignal3').classList.add('hidden');
        }
    }

    initProjWarpCanvas();
    _renderProjCamList();
}

Object.assign(window, {
    selectProjConfig,
    toggleProjSettings,
    projRemoveLastPoint,
    projClearPoints,
    projToggleApply,
    projResultZoom,
    projResultDragStart,
    projResultDragMove,
    projResultDragEnd,
    projCalculateLUT,
})