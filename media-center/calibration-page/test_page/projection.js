// ── Состояние ─────────────────────────────────────────────
import {log, showToast} from "./utility.js";
import {sendWSMessage} from "./app.js";

const projState = {
    settingsOpen: false,

    // Серверные данные
    presets:      [],          // [{config_key, name}]
    activePreset: null,        // { config_key, name, cameras: [...] }

    // Выбор пользователя
    activeCam:    null,        // ключ камеры (front / right_front / ...)

    // Точки по камерам в памяти (нормализованные 0..1)
    pointsByCam:  {},          // { [key]: [{x,y,id}, ...] }
    points:       [],          // буфер активной камеры

    // Сервер сообщил, что у этих камер уже накоплено max_points
    doneSet:      new Set(),

    // Лимит точек на камеру — приходит с сервера в каждой камере
    maxPointsByCam: {},        // { [key]: number }
    // Слоаврь соответсия камер
    camId: {},                 // { [key]: camera_id}

    applied:      false,
    result:       { scale: 1, ox: 0, oy: 0, dragging: false, startX: 0, startY: 0 },
};

let _projDraggingPoint = null;
let _projDragMoved     = false;
let _projDragStartX    = 0;   // нормализованная стартовая позиция курсора
let _projDragStartY    = 0;
const DRAG_THRESHOLD   = 0.005; // в долях canvas — старт движения только после смещения

const PROJ_POSITION_LABELS = {
    front:        'Передняя',
    right:        'Правая',
    right_front:  'Спереди правая',
    right_back:   'Сзади правая',
    back:         'Задняя',
    left:         'Левая',
    left_back:    'Сзади левая',
    left_front:   'Спереди левая',
};


// ── Настройки ─────────────────────────────────────────────
function toggleProjSettings() {
    projState.settingsOpen = !projState.settingsOpen;
    document.getElementById('projSettingsDrawer').classList.toggle('open', projState.settingsOpen);
    document.getElementById('projSettingsTab').classList.toggle('open', projState.settingsOpen);
    document.getElementById('projWarpArea').classList.toggle('shifted',    projState.settingsOpen);
}

function toggleVehicleSelect() {
    const wrap = document.getElementById('vehicleSelect');
    wrap.classList.contains('open') ? closeVehicleSelect() : openVehicleSelect();
}

function openVehicleSelect() {
    document.getElementById('vehicleSelect').classList.add('open');
    setTimeout(() => document.addEventListener('click', _onVehicleSelectOutside), 0);
    // При открытии — обновим список с сервера
    requestProjectionList();
}

function closeVehicleSelect() {
    document.getElementById('vehicleSelect').classList.remove('open');
    document.removeEventListener('click', _onVehicleSelectOutside);
}

function _onVehicleSelectOutside(e) {
    if (!document.getElementById('vehicleSelect').contains(e.target)) {
        closeVehicleSelect();
    }
}

function _renderVehicleList() {
    const list = document.getElementById('vehicleSelectList');
    list.innerHTML = '';

    if (!projState.presets.length) {
        list.innerHTML = `<div class="custom-select-empty">Список не получен</div>`;
        return;
    }

    projState.presets.forEach(p => {
        const el = document.createElement('div');
        const isSelected = projState.activePreset?.config_key === p.config_key;
        el.className = 'custom-select-item' + (isSelected ? ' selected' : '');
        el.innerHTML = `<span class="custom-select-item-name">${p.name ?? p.config_key}</span>`;
        el.onclick = () => selectProjectionPreset(p);
        list.appendChild(el);
    });
}

function selectProjectionPreset(p) {
    const label = document.getElementById('vehicleSelectLabel');
    label.textContent = p.name ?? p.config_key;
    label.classList.add('selected');
    closeVehicleSelect();

    // Запрашиваем у сервера полную информацию по пресету
    requestSetProjectionConfiguration(p.config_key);
}

// ============================================================================
// Список камер активного пресета
// ============================================================================
function _renderProjCamList() {
    const list = document.getElementById('projCamList');
    list.innerHTML = '';

    const cams = projState.activePreset?.cameras ?? [];
    if (!cams.length) {
        list.innerHTML = `<div class="proj-cam-empty">Выберите конфигурацию</div>`;
        return;
    }

    cams.forEach(cam => {
        const baseLabel = cam.name || PROJ_POSITION_LABELS[cam.key] || cam.key;
        const camId     = projState.camId?.[cam.key];
        const label     = camId
            ? `${baseLabel} <span class="proj-cam-id">[${camId}]</span>`
            : baseLabel;

        const isActive  = projState.activeCam === cam.key;
        const isDone    = projState.doneSet.has(cam.key);

        const liveCount = isActive ? projState.points.length : (projState.pointsByCam[cam.key]?.length ?? 0);
        const maxPoints = cam.max_points ?? 0;

        const el = document.createElement('div');
        el.className = 'proj-cam-item' + (isActive ? ' active' : '');
        el.innerHTML = `
            <div class="proj-cam-radio"></div>
            <span class="proj-cam-name">${label}</span>
            <span class="proj-cam-count">${liveCount}/${maxPoints}</span>
            <div class="proj-cam-done ${isDone ? 'done' : ''}"></div>
        `;
        el.onclick = () => selectProjCamera(cam.key);
        list.appendChild(el);
    });

    _updateLutButtonState();
}

function selectProjCamera(key) {
    projState.activeCam = key;
    projState.applied   = false;
    document.getElementById('projWarpWrapper')?.classList.remove('applied');

    projState.points = (projState.pointsByCam[key] ?? []).slice();

    _renderProjCamList();
    _projUpdateUI();
    _projDraw();
}


function initProjWarpCanvas() {
    const canvas  = document.getElementById('projWarpCanvas');
    const wrapper = document.getElementById('uiCanvasLayer');
    const video   = document.getElementById('remoteVideo');

    canvas.addEventListener('pointerdown', _projPointerDown);
    canvas.addEventListener('pointermove', _projPointerMove);
    canvas.addEventListener('pointerup',   _projPointerUp);

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

function getNormalizedCanvasCoords(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top)  / rect.height;
    return {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
    };
}

/* Найти точку под курсором (всё в нормализованных координатах) */
function _projHitPoint(nx, ny) {
    const canvas = document.getElementById('projWarpCanvas');
    if (!canvas.width || !canvas.height) return -1;

    // Радиус срабатывания в пикселях → переводим в нормализованные
    const HIT_PX = 14;
    const hitNX  = HIT_PX / canvas.width;
    const hitNY  = HIT_PX / canvas.height;

    for (let i = projState.points.length - 1; i >= 0; i--) {
        const p = projState.points[i];
        // Проверка по эллипсу (canvas не квадратный)
        const dx = (p.x - nx) / hitNX;
        const dy = (p.y - ny) / hitNY;
        if (dx * dx + dy * dy < 1) return i;
    }
    return -1;
}

function _projPointerDown(e) {
    if (projState.applied) return;

    // Без выбранной камеры ставить или таскать точки нельзя
    if (!projState.activeCam) {
        showToast('Камера не выбрана', 'Выберите камеру в настройках', 'err');
        return;
    }

    const canvas = e.currentTarget;
    const { x, y } = getNormalizedCanvasCoords(canvas, e);

    _projDragStartX    = x;
    _projDragStartY    = y;
    _projDragMoved     = false;
    _projDraggingPoint = _projHitPoint(x, y);

    if (_projDraggingPoint !== -1) {
        canvas.setPointerCapture(e.pointerId);
    }
}

function _projPointerMove(e) {
    if (projState.applied) return;
    if (!projState.activeCam) return;
    if (_projDraggingPoint === -1 || _projDraggingPoint === null) return;

    const canvas = e.currentTarget;
    const { x, y } = getNormalizedCanvasCoords(canvas, e);

    if (!_projDragMoved) {
        const dist = Math.hypot(x - _projDragStartX, y - _projDragStartY);
        if (dist < DRAG_THRESHOLD) return;
        _projDragMoved = true;
    }

    projState.points[_projDraggingPoint].x = x;
    projState.points[_projDraggingPoint].y = y;
    _projDraw();
}

function _projPointerUp(e) {
    if (projState.applied) return;
    if (!projState.activeCam) return;

    const canvas        = e.currentTarget;
    const hitExisting   = _projDraggingPoint !== -1 && _projDraggingPoint !== null;
    const wasDragMove   = _projDragMoved;

    if (hitExisting) canvas.releasePointerCapture(e.pointerId);

    _projDraggingPoint = null;
    _projDragMoved     = false;

    // Создаём новую точку только если не попали в существующую и не было drag
    if (!hitExisting && !wasDragMove) {
        const maxPts = _currentMaxPoints();
        if (maxPts <= 0) {
            showToast('Лимит точек не получен', 'Камера не содержит max_points', 'err');
            return;
        }
        if (projState.points.length >= maxPts) {
            showToast('Достигнут лимит точек', `Максимум ${maxPts}`, 'warn');
            return;
        }
        const { x, y } = getNormalizedCanvasCoords(canvas, e);
        projState.points.push({ x, y, id: Date.now() });
        _projUpdateUI();
        _renderProjCamList();
    }

    _projDraw();
}

/* Отрисовка — все координаты в долях, для рендера умножаем на canvas size */
function _projDraw() {
    const canvas = document.getElementById('projWarpCanvas');
    const ctx    = canvas.getContext('2d');
    const W      = canvas.width;
    const H      = canvas.height;

    ctx.clearRect(0, 0, W, H);

    const pts = projState.points;
    if (!pts.length) return;

    // Конвертация нормализованных → пиксельные
    const toPx = p => ({ x: p.x * W, y: p.y * H });

    // Линии
    if (pts.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(200,255,64,0.4)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 4]);
        pts.forEach((p, i) => {
            const px = toPx(p);
            i === 0 ? ctx.moveTo(px.x, px.y) : ctx.lineTo(px.x, px.y);
        });
        if (pts.length === projState.maxPoints) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
    }

    const R = 7;

    pts.forEach((p, i) => {
        const { x, y } = toPx(p);

        // Подложка
        ctx.beginPath();
        ctx.arc(x, y, R + 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();

        // Заливка точки
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fillStyle   = '#c8ff40';
        ctx.strokeStyle = '#0a0a0c';
        ctx.lineWidth   = 1.5;
        ctx.fill();
        ctx.stroke();

        // Номер сбоку
        const label = String(i + 1);
        const lx    = x + R + 6;
        const ly    = y;
        const pad   = 3;
        ctx.font          = 'bold 11px monospace';
        ctx.textAlign     = 'left';
        ctx.textBaseline  = 'middle';
        const tw = ctx.measureText(label).width;

        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(lx - pad, ly - 8, tw + pad * 2, 16, 3);
        ctx.fill();

        ctx.fillStyle = '#c8ff40';
        ctx.fillText(label, lx, ly);
    });
}

function _projUpdateUI() {
    const n = projState.points.length;
    const maxPts = _currentMaxPoints();
    const badge = document.getElementById('projPointBadge');
    if (badge) badge.textContent = `${n} / ${maxPts}`;
}

function projRemoveLastPoint() {
    projState.points.pop();
    _projDraw();
    _projUpdateUI();
    _renderProjCamList();
}

function projClearPoints() {
    projState.points  = [];
    projState.applied = false;
    document.getElementById('projWarpWrapper')?.classList.remove('applied');
    const applyBtn = document.getElementById('projApplyBtn');
    if (applyBtn) applyBtn.textContent = '⊛ Применить warp';
    const editState = document.getElementById('projEditState');
    if (editState) editState.textContent = 'Режим: редактирование';
    _projDraw();
    _projUpdateUI();
    _renderProjCamList();
}

function projToggleApply() {
    if (projState.applied) {
        projState.points  = [...projState.savedPoints];
        projState.applied = false;
        document.getElementById('projWarpWrapper').classList.remove('applied');
        document.getElementById('projApplyBtn').textContent = '⊛ Применить warp';
        document.getElementById('projEditState').textContent = 'Режим: редактирование';
        _projDraw();
        return;
    }

    if (!projState.activeCam) {
        showToast('Камера не выбрана', 'Выберите камеру в настройках', 'err');
        return;
    }

    const maxPts = _currentMaxPoints();
    if (projState.points.length < maxPts) {
        showToast('Недостаточно точек', `Необходимо ${maxPts} точки`, 'err');
        return;
    }

    //projState.savedPoints = [...projState.points];
    //projState.applied     = true;

    //document.getElementById('projWarpWrapper').classList.add('applied');
    //document.getElementById('projApplyBtn').textContent = '↩ Редактировать';
    //document.getElementById('projEditState').textContent = 'Режим: просмотр';

    const normPoints = projState.points.map(p => ({
        x: +p.x.toFixed(8),
        y: +p.y.toFixed(8),
    }));

    requestWarp(normPoints);

    //projState.doneSet.add(projState.activeCam);
    //projState.pointsByCam[projState.activeCam] = projState.points.slice();
    //_renderProjCamList();

    //const canvas = document.getElementById('projWarpCanvas');
    //const ctx = canvas.getContext('2d');
    //ctx.clearRect(0, 0, canvas.width, canvas.height);
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
    // Сейчас показываем либо <img> (после warp), либо <canvas> (если когда-то
    // решим рисовать туда напрямую). Берём то, что реально видно.
    const target =
        document.getElementById('projResultCanvasImg') ||
        document.getElementById('projResultImg');
    if (target) {
        target.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    }
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
const LUT_ID_RE = /^[a-z][a-z0-9_]*$/;

function projCalculateLUT() {
    const cams = projState.activePreset?.cameras ?? [];
    const allDone = cams.length > 0 && cams.every(c => projState.doneSet.has(c.key));
    if (!allDone) {
        showToast('Нельзя сохранить', 'Не все камеры применены', 'err');
        return;
    }
    openLutSaveModal();
}

function openLutSaveModal() {
    const backdrop = document.getElementById('lutSaveModalBackdrop');
    backdrop.classList.remove('hidden');

    // Автозаполнение
    const idInput   = document.getElementById('lutSaveId');
    const nameInput = document.getElementById('lutSaveName');
    idInput.value   = _generateLutId();
    nameInput.value = '';
    _validateLutId();

    // Слушатели на ходу
    idInput.oninput   = _validateLutId;
    nameInput.oninput = _validateLutSubmit;

    setTimeout(() => idInput.focus(), 30);
}

function closeLutSaveModal(e) {
    if (e && e.target.id !== 'lutSaveModalBackdrop') return;
    document.getElementById('lutSaveModalBackdrop').classList.add('hidden');
}

function _generateLutId() {
    // Базовая часть из имени активного пресета (если есть), иначе "config"
    const presetName = projState.activePreset?.name ?? 'config';
    const base = presetName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')   // убираем не-латиницу
        .replace(/^_+|_+$/g, '')       // обрезаем подчёркивания по краям
        .replace(/^[0-9]+/, '');       // не начинаем с цифры

    const safeBase = base || 'config';

    // Суффикс — короткий timestamp в base36, чтобы не было коллизий
    const suffix = Date.now().toString(36).slice(-5);
    return `${safeBase}_${suffix}`;
}

// ── Валидация ─────────────────────────────────────────────
function _validateLutId() {
    const input = document.getElementById('lutSaveId');
    const hint  = document.getElementById('lutSaveIdHint');
    const val   = input.value.trim();

    let ok = true;
    if (!val) {
        hint.textContent = 'ID не может быть пустым';
        hint.classList.add('err');
        ok = false;
    } else if (!LUT_ID_RE.test(val)) {
        hint.textContent = 'Только латиница, цифры и _, начинается с буквы';
        hint.classList.add('err');
        ok = false;
    } else {
        hint.textContent = 'Только латиница, цифры и _';
        hint.classList.remove('err');
    }

    input.classList.toggle('invalid', !ok);
    _validateLutSubmit();
    return ok;
}

function _validateLutSubmit() {
    const idOk    = LUT_ID_RE.test(document.getElementById('lutSaveId').value.trim());
    const nameOk  = document.getElementById('lutSaveName').value.trim().length > 0;
    document.getElementById('lutSaveConfirmBtn').disabled = !(idOk && nameOk);
}

// ── Джойстик ─────────────────────────────────────────────
(function initProjJoystick() {
    const nub = document.getElementById('projJoyNub');
    const joy = document.getElementById('projJoystick');
    if (!nub || !joy) return;

    const MAX_R    = 30;
    const THROTTLE = 80;
    let dragging   = false;
    let lastSend   = 0;

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
            sendWSMessage('projection_shift', {
                dx: +(dx / MAX_R).toFixed(3),
                dy: +(dy / MAX_R).toFixed(3),
            });
        }
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        nub.style.transition = 'transform 0.2s';
        nub.style.transform  = 'translate(0,0)';
        setTimeout(() => nub.style.transition = '', 200);

        sendWSMessage('projection_shift', { dx: 0, dy: 0 });
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

// Отображение изображения в элементе

function showProjectionCanvas(bytes) {
    if (!bytes || !bytes.byteLength) return;

    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url  = URL.createObjectURL(blob);

    const wrapper = document.getElementById('projResultCanvas');

    // Скрываем родной <canvas> — будем показывать <img>
    const canvasEl = document.getElementById('projResultImg');
    if (canvasEl) canvasEl.style.display = 'none';

    let img = document.getElementById('projResultCanvasImg');
    if (!img) {
        img = document.createElement('img');
        img.id = 'projResultCanvasImg';
        // Те же transform-правила, что и у canvas — чтобы pan/zoom работали без правок
        img.style.cssText =
            'position:absolute;' +
            'max-width:100%;max-height:100%;' +
            'object-fit:contain;' +
            'transform-origin:center;' +
            'user-select:none;pointer-events:none;' +
            'z-index:1;';
        wrapper.appendChild(img);
    }

    if (img._prevUrl) URL.revokeObjectURL(img._prevUrl);
    img.src = url;
    img._prevUrl = url;

    // Сброс трансформации при новом канвасе (чтобы новый кадр не появлялся
    // случайно сдвинутым/масштабированным от прошлого взаимодействия)
    projState.result.scale = 1;
    projState.result.ox    = 0;
    projState.result.oy    = 0;
    img.style.transform    = 'translate(0px, 0px) scale(1)';

    // Прячем "Нет данных"
    document.getElementById('noSignalResult')?.classList.add('hidden');
}

// Хелперы
function _currentMaxPoints() {
    if (!projState.activeCam) return 0;
    return projState.maxPointsByCam[projState.activeCam] ?? 0;
}

function _updateLutButtonState() {
    const btn = document.querySelector('.proj-lut-btn');
    if (!btn) return;

    const cams = projState.activePreset?.cameras ?? [];
    const allDone = cams.length > 0 && cams.every(c => projState.doneSet.has(c.key));

    btn.disabled = !allDone;
    btn.title = allDone
        ? 'Сохранить конфигурацию stitching'
        : 'Доступно после применения warp на всех камерах';
}


// ============================================================================
// Функции для работы с сервером
// ============================================================================
const TYPE_PROJECTION_CONFIGURATION = 'projection_configuration';
const METHOD_PROJECTION_GET_LIST    = 'get_list';
const METHOD_PROJECTION_SET_PRESET    = 'set_preset';
const METHOD_PROJECTION_APPLY_WARP = 'apply_warp';
const METHOD_PROJECTION_SAVE_LUT = 'save_lut';

function requestProjectionList() {
    sendWSMessage(TYPE_PROJECTION_CONFIGURATION, {
        method: METHOD_PROJECTION_GET_LIST,
    });
}

function requestSetProjectionConfiguration(configKey) {
    sendWSMessage(TYPE_PROJECTION_CONFIGURATION, {
        method:     METHOD_PROJECTION_SET_PRESET,
        config_key: configKey,
    });
}

function requestWarp(normPoints) {
    sendWSMessage(TYPE_PROJECTION_CONFIGURATION, {
        method: 'apply_warp',
        key: projState.activeCam,
        src_points: normPoints,
    });
}

function submitLutSave() {
    if (!_validateLutId()) return;

    const id   = document.getElementById('lutSaveId').value.trim();
    const name = document.getElementById('lutSaveName').value.trim();
    if (!name) return;

    // Блокируем кнопку, чтобы не было двойных отправок
    const btn = document.getElementById('lutSaveConfirmBtn');
    btn.disabled    = true;
    btn.textContent = 'Сохранение...';

    sendWSMessage(TYPE_PROJECTION_CONFIGURATION, {
        method: METHOD_PROJECTION_SAVE_LUT,
        id,
        name,
    });

    log(`save_lut sent: id=${id} name="${name}"`, 'info');
}

// Точка входа обработчика для это страницы
export function handleProjectionMessage(msg) {
    const meta = msg.meta ?? {};
    if (meta.method === METHOD_PROJECTION_GET_LIST) {
        projState.presets = meta.presets ?? [];
        _renderVehicleList();
        return;
    }
    if (meta.method === METHOD_PROJECTION_SET_PRESET) {
        _applyProjectionItem(meta);
        return;
    }

    if (meta.method === METHOD_PROJECTION_APPLY_WARP) {
        const cameraKey = meta.key;

        if (msg.ret !== true) {
            const err = meta.error ?? 'Сервер вернул ошибку';
            showToast('Warp не применён', err, 'err');
            return;
        }

        if (msg._imageBytes && msg._imageBytes.byteLength) {
            showProjectionCanvas(msg._imageBytes);
        }

        projState.pointsByCam[cameraKey] = (cameraKey === projState.activeCam)
            ? projState.points.slice()
            : (projState.pointsByCam[cameraKey] ?? []).slice();

        // 3) Отмечаем камеру как готовую.
        projState.doneSet.add(cameraKey);
        _renderProjCamList();

        if (meta.camera_id !== undefined && meta.camera_id !== null) {
            projState.camId[cameraKey] = meta.camera_id;
            log(`apply_warp: camId[${cameraKey}] = ${meta.camera_id}`, 'info');
        } else {
            log(`apply_warp: server did not return camera_id for <${cameraKey}>`, 'warn');
        }
        // Дополнительно: можно подсветить камеру как «отображена» в списке.
        // doneSet уже выставляется в projToggleApply / при сохранении точек,
        // отдельно тут ничего не делаем.
        return;
    }

    if (meta.method === METHOD_PROJECTION_SAVE_LUT) {
        const btn  = document.getElementById('lutSaveConfirmBtn');
        if (btn) {
            btn.disabled    = false;
            btn.textContent = 'Сохранить';
        }

        if (msg.ret !== true) {
            const err = meta.description ?? 'Сервер вернул ошибку';
            log(`save_lut failed: ${err}`, 'error');
            showToast('Не сохранено', err, 'err');
            return;
        }

        log(`save_lut ok: id=${meta.id ?? '?'}`, 'info');
        showToast('Сохранено', `Конфигурация <${meta.id ?? ''}>`, 'ok');
        closeLutSaveModal();
    }
}

function _applyProjectionItem(meta) {
    projState.activePreset = {
        config_key: meta.config_key,
        name:       meta.name,
        cameras:    meta.cameras ?? [],
    };

    // Сброс при смене пресета
    projState.activeCam      = null;
    projState.pointsByCam    = {};
    projState.points         = [];
    projState.doneSet        = new Set();
    projState.maxPointsByCam = {};
    projState.camId          = {};
    projState.applied        = false;

    projState.activePreset.cameras.forEach(cam => {
        projState.maxPointsByCam[cam.key] = cam.max_points ?? 0;
        if ((cam.points_count ?? 0) >= (cam.max_points ?? 0) && (cam.max_points ?? 0) > 0) {
            projState.doneSet.add(cam.key);
        }
    });

    _renderProjCamList();
    _projUpdateUI();
    _projDraw();
}

// Доступ к UI
Object.assign(window, {
    toggleProjSettings,
    projRemoveLastPoint,
    projClearPoints,
    projToggleApply,
    projResultZoom,
    projResultDragStart,
    projResultDragMove,
    projResultDragEnd,
    projCalculateLUT,
    toggleVehicleSelect,
    closeLutSaveModal,
    submitLutSave,
})