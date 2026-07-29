import {
    confState,
    emitConfChange,
    getList,
    HANDLE_SIZE,
    ROTATION_STALK,
    type HandleName,
} from '../../state/conf-store';
import type { ConfCamera, ConfImage, ConfItemType, ConfZone } from '../../types';
import {
    cameraMinSize,
    canvasToWorld,
    clampToField,
    clampZoneToCamera,
    confDraw,
    snap,
    zoneFitsCamera,
} from './conf-canvas';
import { confCreateCameraFromRect, confPlaceZone } from './conf-actions';

// Pointer-логика конфигуратора. Мутирует confState напрямую и перерисовывает
// холст сам; emitConfChange вызывается только в точках фиксации.
// Координаты мира — метры.

interface AttachOptions {
    /** Отрисовка позиции курсора. Идёт мимо React: срабатывает на каждый pointermove. */
    onCursor: (wx: number, wy: number) => void;
    /** Экран конфигуратора активен. Глобальные горячие клавиши работают только тогда. */
    isActive: () => boolean;
    /** Сообщение пользователю (toast). */
    onNotice: (title: string, desc: string, type: 'ok' | 'err' | 'info') => void;
}

type AnyItem = ConfCamera | ConfZone | ConfImage;

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export function attachConfInteract(canvas: HTMLCanvasElement, opts: AttachOptions): () => void {
    let panStart: { x: number; y: number } | null = null;

    // Растягивание области инструментом «Камера»
    let drawStart: { x: number; y: number } | null = null;
    let drawBounds: Rect | null = null;

    function onDown(e: PointerEvent): void {
        // Pan
        if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
            panStart = { x: e.clientX - confState.view.ox, y: e.clientY - confState.view.oy };
            canvas.setPointerCapture(e.pointerId);
            return;
        }

        const tool = confState.tool;

        // Правая кнопка в режиме разметки выбирает камеру, внутри которой рисуем
        if (tool === 'zone' && e.button === 2) {
            const p = canvasToWorld(e.clientX, e.clientY);
            const cam = hitCamera(p.x, p.y);
            if (cam) {
                confState.selected = { type: 'camera', id: cam.id };
                confDraw();
                emitConfChange();
            } else {
                opts.onNotice('Камера не выбрана', 'Нажмите правой кнопкой по камере', 'err');
            }
            return;
        }

        if (e.button !== 0) return;

        if (tool === 'camera') {
            startDrawingCamera(e);
            return;
        }

        if (tool === 'zone') {
            placeMat(e);
            return;
        }

        const w = canvasToWorld(e.clientX, e.clientY);

        // 1. Handle у текущего выделенного
        if (confState.selected) {
            const sel = confState.selected;
            const selItem = getList(sel.type).find(i => i.id === sel.id) as AnyItem | undefined;
            if (selItem) {
                const handle = hitHandle(selItem, sel.type, w.x, w.y);
                if (handle === 'rotate') {
                    confState.rotating = { id: sel.id, type: sel.type };
                    canvas.setPointerCapture(e.pointerId);
                    confDraw();
                    return;
                }
                if (handle) {
                    confState.resize = { id: sel.id, type: sel.type, handle };
                    canvas.setPointerCapture(e.pointerId);
                    confDraw();
                    return;
                }
            }
        }

        // 2. Hit test элементов
        const hit = hitTest(w.x, w.y);

        if (hit) {
            confState.selected = hit;
            const item = getList(hit.type).find(i => i.id === hit.id);
            if (item) {
                confState.dragging = {
                    id: hit.id,
                    type: hit.type,
                    offsetX: w.x - item.x,
                    offsetY: w.y - item.y,
                };
            }
            canvas.setPointerCapture(e.pointerId);
        } else {
            confState.selected = null;
        }

        confDraw();
        emitConfChange();
    }

    /** Начинает растягивание камеры. Границей служит поле. */
    function startDrawingCamera(e: PointerEvent): void {
        const f = confState.field;
        drawBounds = { x: 0, y: 0, w: f.w, h: f.h };

        const p = clampToRect(snapPoint(canvasToWorld(e.clientX, e.clientY)), drawBounds);
        drawStart = p;
        confState.draft = { x: p.x, y: p.y, w: 0, h: 0 };
        canvas.setPointerCapture(e.pointerId);
        confDraw();
    }

    // Мат ставится одним кликом: сторона квадрата задана полем «Сторона мата»
    function placeMat(e: PointerEvent): void {
        const cam = selectedCamera();
        if (!cam) {
            opts.onNotice('Камера не выбрана', 'Выберите камеру правой кнопкой мыши', 'err');
            return;
        }

        const p = snapPoint(canvasToWorld(e.clientX, e.clientY));
        const err = confPlaceZone(cam.id, p.x, p.y);
        if (err) opts.onNotice('Мат не поставлен', err, 'err');
    }

    function onMove(e: PointerEvent): void {
        const w = canvasToWorld(e.clientX, e.clientY);

        opts.onCursor(w.x, w.y);

        // Растягивание камеры
        if (drawStart && drawBounds) {
            const p = clampToRect(snapPoint(w), drawBounds);
            confState.draft = {
                x: Math.min(drawStart.x, p.x),
                y: Math.min(drawStart.y, p.y),
                w: Math.abs(p.x - drawStart.x),
                h: Math.abs(p.y - drawStart.y),
            };
            confDraw();
            return;
        }

        // Pan
        if (panStart) {
            confState.view.ox = e.clientX - panStart.x;
            confState.view.oy = e.clientY - panStart.y;
            confDraw();
            return;
        }

        // Поворот
        if (confState.rotating) {
            const r = confState.rotating;
            const item = getList(r.type).find(i => i.id === r.id) as ConfZone | undefined;
            if (item) {
                const cx = item.x + item.w / 2;
                const cy = item.y + item.h / 2;
                let angle = (Math.atan2(w.x - cx, -(w.y - cy)) * 180) / Math.PI;

                // Shift — шаг 90°
                if (e.shiftKey) {
                    angle = Math.round(angle / 90) * 90;
                }

                const next = ((Math.round(angle) % 360) + 360) % 360;
                // Повёрнутый квадрат шире прямого: угол, при котором мат
                // перестаёт помещаться в камеру, просто не применяется
                if (rotationFits(item, next)) {
                    item.rotation = next;
                    clampZoneToCamera(item);
                    confDraw();
                }
            }
            return;
        }

        if (confState.resize) {
            const r = confState.resize;
            const item = getList(r.type).find(i => i.id === r.id) as AnyItem | undefined;
            if (item) {
                applyResize(item, r.type, r.handle, w.x, w.y);
                confDraw();
            }
            return;
        }

        // Drag
        const d = confState.dragging;
        if (!d) return;

        const item = getList(d.type).find(i => i.id === d.id) as AnyItem | undefined;
        if (!item) return;

        const nx = snap(w.x - d.offsetX);
        const ny = snap(w.y - d.offsetY);

        if (d.type === 'camera') {
            const oldX = item.x;
            const oldY = item.y;
            const clamped = clampToField(nx, ny, item.w, item.h);
            item.x = clamped.x;
            item.y = clamped.y;

            const dx = item.x - oldX;
            const dy = item.y - oldY;
            confState.zones.forEach(zone => {
                if (zone.cameraId !== item.id) return;
                zone.x += dx;
                zone.y += dy;
                clampZoneToCamera(zone);
            });
        } else if (d.type === 'zone') {
            item.x = nx;
            item.y = ny;
            clampZoneToCamera(item as ConfZone);
        } else {
            const clamped = clampToField(nx, ny, item.w, item.h);
            item.x = clamped.x;
            item.y = clamped.y;
        }

        confDraw();
    }

    function onUp(e: PointerEvent): void {
        // Завершение растягивания камеры
        if (drawStart) {
            const draft = confState.draft;
            const minSize = confState.field.step * 2;

            drawStart = null;
            confState.draft = null;
            canvas.releasePointerCapture(e.pointerId);

            if (draft && draft.w >= minSize && draft.h >= minSize) {
                confCreateCameraFromRect(draft);
            } else {
                // Слишком мелкая область — считаем это промахом, а не созданием
                confDraw();
            }

            drawBounds = null;
            return;
        }

        const wasInteracting = Boolean(
            panStart || confState.dragging || confState.resize || confState.rotating,
        );

        panStart = null;
        confState.dragging = null;
        confState.resize = null;
        confState.rotating = null;
        canvas.releasePointerCapture(e.pointerId);

        // Точка фиксации: размеры и угол в панели должны догнать холст.
        if (wasInteracting) emitConfChange();
    }

    function onWheel(e: WheelEvent): void {
        e.preventDefault();
        const v = confState.view;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const prev = v.scale;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;

        // scale — экранных пикселей на метр, поэтому пределы зума считаются от
        // размера поля: от «поле в 10 px» до «поле в 20000 px»
        const side = Math.max(confState.field.w, confState.field.h);
        v.scale = Math.min(20000 / side, Math.max(10 / side, prev * factor));

        const ratio = v.scale / prev;
        v.ox = mx - (mx - v.ox) * ratio;
        v.oy = my - (my - v.oy) * ratio;

        confDraw();
    }

    function onKey(e: KeyboardEvent): void {
        if (!opts.isActive()) return;

        // Горячие клавиши не должны срабатывать при вводе в поля панели
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

        // Выбор инструмента. По e.code, чтобы работало в любой раскладке.
        if (e.shiftKey && (e.code === 'KeyQ' || e.code === 'KeyW')) {
            e.preventDefault();
            confState.tool = e.code === 'KeyQ' ? 'camera' : 'zone';
            confState.draft = null;
            confDraw();
            emitConfChange();
            return;
        }

        if (e.key === 'Delete' && confState.selected) {
            const { type, id } = confState.selected;
            const list = getList(type);
            const idx = list.findIndex(i => i.id === id);
            if (idx !== -1) list.splice(idx, 1);
            if (type === 'camera') {
                confState.zones = confState.zones.filter(z => z.cameraId !== id);
            }
            confState.selected = null;
            confDraw();
            emitConfChange();
        }

        if ((e.key === 'r' || e.key === 'к') && confState.selected?.type === 'zone') {
            const zone = confState.zones.find(z => z.id === confState.selected?.id);
            if (zone) {
                const next = (zone.rotation + 90) % 360;
                if (rotationFits(zone, next)) {
                    zone.rotation = next;
                    clampZoneToCamera(zone);
                    confDraw();
                    emitConfChange();
                } else {
                    const cam = confState.cameras.find(c => c.id === zone.cameraId);
                    opts.onNotice(
                        'Поворот невозможен',
                        `Повёрнутый мат не помещается в камеру «${cam?.name ?? '—'}»`,
                        'err',
                    );
                }
            }
        }

        if ((e.key === 'c' || e.key === 'с') && confState.selected?.type === 'image') {
            if (confState.dragging && confState.dragging.type === 'image') {
                confState.dragging = null;
            }

            const img = confState.images.find(i => i.id === confState.selected?.id);
            if (img) {
                const f = confState.field;
                img.x = snap((f.w - img.w) / 2);
                img.y = snap((f.h - img.h) / 2);
                confDraw();
                emitConfChange();
            }
        }
    }

    // Правая кнопка занята выбором камеры — системное меню тут мешает
    function onContextMenu(e: MouseEvent): void {
        e.preventDefault();
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKey);

    return () => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onContextMenu);
        window.removeEventListener('keydown', onKey);
    };
}

function rotationFits(zone: ConfZone, rotationDeg: number): boolean {
    const cam = confState.cameras.find(c => c.id === zone.cameraId);
    if (!cam) return true;
    return zoneFitsCamera(cam, zone.w, rotationDeg);
}

function selectedCamera(): ConfCamera | null {
    const sel = confState.selected;
    if (sel?.type !== 'camera') return null;
    return confState.cameras.find(c => c.id === sel.id) ?? null;
}

function hitCamera(wx: number, wy: number): ConfCamera | null {
    for (let i = confState.cameras.length - 1; i >= 0; i--) {
        const c = confState.cameras[i];
        if (wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h) return c;
    }
    return null;
}

function snapPoint(p: { x: number; y: number }): { x: number; y: number } {
    return { x: snap(p.x), y: snap(p.y) };
}

function clampToRect(p: { x: number; y: number }, r: Rect): { x: number; y: number } {
    return {
        x: Math.max(r.x, Math.min(r.x + r.w, p.x)),
        y: Math.max(r.y, Math.min(r.y + r.h, p.y)),
    };
}

function hitTest(wx: number, wy: number): { type: ConfItemType; id: string } | null {
    for (let i = confState.zones.length - 1; i >= 0; i--) {
        const z = confState.zones[i];
        if (wx >= z.x && wx <= z.x + z.w && wy >= z.y && wy <= z.y + z.h)
            return { type: 'zone', id: z.id };
    }
    for (let i = confState.cameras.length - 1; i >= 0; i--) {
        const c = confState.cameras[i];
        if (wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h)
            return { type: 'camera', id: c.id };
    }
    for (let i = confState.gabarits.length - 1; i >= 0; i--) {
        const g = confState.gabarits[i];
        if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + g.h)
            return { type: 'gabarit', id: g.id };
    }
    for (let i = confState.images.length - 1; i >= 0; i--) {
        const img = confState.images[i];
        if (wx >= img.x && wx <= img.x + img.w && wy >= img.y && wy <= img.y + img.h)
            return { type: 'image', id: img.id };
    }
    return null;
}

/** Hit test handle — в мировых координатах. */
function hitHandle(
    item: AnyItem,
    type: ConfItemType,
    wx: number,
    wy: number,
): HandleName | 'rotate' | null {
    const hitR = (HANDLE_SIZE + 2) / confState.view.scale;

    // Для зон координаты нужно повернуть обратно
    let lx = wx;
    let ly = wy;
    const rotation = type === 'zone' ? (item as ConfZone).rotation : 0;
    if (rotation) {
        const cx = item.x + item.w / 2;
        const cy = item.y + item.h / 2;
        const rad = (-rotation * Math.PI) / 180;
        const dx = wx - cx;
        const dy = wy - cy;
        lx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
        ly = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    }

    // Handle поворота — только у зон; ручек размера у них нет вовсе:
    // сторона квадрата общая и меняется полем в панели
    if (type === 'zone') {
        const stalkWorld = ROTATION_STALK / confState.view.scale;
        const rotHx = item.x + item.w / 2;
        const rotHy = item.y - stalkWorld;
        if (Math.abs(lx - rotHx) <= hitR * 1.5 && Math.abs(ly - rotHy) <= hitR * 1.5) {
            return 'rotate';
        }
        return null;
    }

    const handles: Array<{ name: HandleName; hx: number; hy: number }> = [
        { name: 'tl', hx: item.x, hy: item.y },
        { name: 'mt', hx: item.x + item.w / 2, hy: item.y },
        { name: 'tr', hx: item.x + item.w, hy: item.y },
        { name: 'ml', hx: item.x, hy: item.y + item.h / 2 },
        { name: 'mr', hx: item.x + item.w, hy: item.y + item.h / 2 },
        { name: 'bl', hx: item.x, hy: item.y + item.h },
        { name: 'mb', hx: item.x + item.w / 2, hy: item.y + item.h },
        { name: 'br', hx: item.x + item.w, hy: item.y + item.h },
    ];

    for (const h of handles) {
        if (Math.abs(lx - h.hx) <= hitR && Math.abs(ly - h.hy) <= hitR) return h.name;
    }
    return null;
}

function applyResize(
    item: AnyItem,
    type: ConfItemType,
    handle: HandleName,
    wx: number,
    wy: number,
): void {
    // Размер разметки общий и меняется только полем в панели
    if (type === 'zone') return;

    const nx = snap(wx);
    const ny = snap(wy);

    let newX = item.x;
    let newY = item.y;
    let newW = item.w;
    let newH = item.h;

    // Камеру нельзя ужать меньше её матов: мат под неё не подстраивается
    let minW = confState.field.step * 2;
    let minH = minW;
    if (type === 'camera') {
        const need = cameraMinSize(item.id);
        minW = Math.max(minW, need.w);
        minH = Math.max(minH, need.h);
    }

    // Горизонталь
    if (handle === 'tl' || handle === 'ml' || handle === 'bl') {
        newW = item.x + item.w - nx;
        newX = nx;
    } else if (handle === 'tr' || handle === 'mr' || handle === 'br') {
        newW = nx - item.x;
    }

    // Вертикаль
    if (handle === 'tl' || handle === 'mt' || handle === 'tr') {
        newH = item.y + item.h - ny;
        newY = ny;
    } else if (handle === 'bl' || handle === 'mb' || handle === 'br') {
        newH = ny - item.y;
    }

    // Минимальный размер
    if (newW < minW) {
        if (handle === 'tl' || handle === 'ml' || handle === 'bl')
            newX = item.x + item.w - minW;
        newW = minW;
    }
    if (newH < minH) {
        if (handle === 'tl' || handle === 'mt' || handle === 'tr')
            newY = item.y + item.h - minH;
        newH = minH;
    }

    // Границы поля
    const f = confState.field;
    if (newX < 0) { newW += newX; newX = 0; }
    if (newY < 0) { newH += newY; newY = 0; }
    if (newX + newW > f.w) newW = f.w - newX;
    if (newY + newH > f.h) newH = f.h - newY;

    // Финальная проверка минимума после clamp
    if (newW < minW) newW = minW;
    if (newH < minH) newH = minH;

    item.x = newX;
    item.y = newY;
    item.w = newW;
    item.h = newH;

    // После ресайза камеры — пережать зоны
    if (type === 'camera') {
        confState.zones.forEach(zone => {
            if (zone.cameraId === item.id) clampZoneToCamera(zone);
        });
    }
}
