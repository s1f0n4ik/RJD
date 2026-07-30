import {
    CAMERA_FRACTION,
    confState,
    emitConfChange,
    fmtM,
    nextColor,
    q,
    QUANTUM,
    uid,
} from '../../state/conf-store';
import type { ConfItemType, ConfSelection, ConfTool, ConfZone } from '../../types';
import {
    clampToField,
    clampZoneToField,
    confDraw,
    snap,
    zoneFitsField,
} from './conf-canvas';

// Операции над confState, вызываемые из панели. Каждая мутирует состояние,
// перерисовывает холст и дёргает emitConfChange.
// Операции, которые могут отказать, возвращают текст причины или null.

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Правка параметров поля. Пережимает все объекты под новые границы. */
export function confUpdateField(next: Partial<{ w: number; h: number; step: number }>): string | null {
    const step = Math.max(QUANTUM, q(next.step ?? confState.field.step));
    const minSize = q(step * 3);
    const w = Math.max(minSize, q(next.w ?? confState.field.w));
    const h = Math.max(minSize, q(next.h ?? confState.field.h));

    // Мат физический и не ужимается — поле не может стать меньше него
    for (const zone of confState.zones) {
        if (zone.w > w || zone.h > h) {
            return `Мат ${fmtM(zone.w)} м не поместится — поле меньше не станет`;
        }
    }

    confState.field.step = step;
    confState.field.w = w;
    confState.field.h = h;

    confState.cameras.forEach(cam => {
        if (cam.w > w) cam.w = w;
        if (cam.h > h) cam.h = h;
        const c = clampToField(cam.x, cam.y, cam.w, cam.h);
        cam.x = c.x;
        cam.y = c.y;
    });

    confState.zones.forEach(zone => clampZoneToField(zone));

    confState.images.forEach(img => {
        if (img.w > w) img.w = w;
        if (img.h > h) img.h = h;
        const c = clampToField(img.x, img.y, img.w, img.h);
        img.x = c.x;
        img.y = c.y;
    });

    confState.gabarits.forEach(g => {
        if (g.w > w) g.w = w;
        if (g.h > h) g.h = h;
        const c = clampToField(g.x, g.y, g.w, g.h);
        g.x = c.x;
        g.y = c.y;
    });

    confDraw();
    emitConfChange();
    return null;
}

// Пикселей канваса экспорта на метр. Геометрию не двигает: меняется только
// разрешение выходного растра.
export function confUpdatePxPerM(value: number): void {
    confState.pxPerM = Math.max(QUANTUM, q(value));
    emitConfChange();
}

/** Габарит один на конфигурацию: повторное нажатие выбирает существующий. */
export function confAddGabarit(): void {
    const existing = confState.gabarits[0];
    if (existing) {
        confState.selected = { type: 'gabarit', id: existing.id };
        confDraw();
        emitConfChange();
        return;
    }

    const f = confState.field;
    const w = snap(f.w * 0.25);
    const h = snap(f.h * 0.5);
    confState.gabarits.push({
        id: uid(),
        x: snap((f.w - w) / 2),
        y: snap((f.h - h) / 2),
        w,
        h,
    });
    confState.selected = { type: 'gabarit', id: confState.gabarits[0].id };
    confDraw();
    emitConfChange();
}

/** Размеры машины в метрах. Ширина идёт вдоль X, длина вдоль Y. */
// Ориентация задана surround-bake: запасной масштаб там считается как
// length / rect.height, то есть длина лежит по оси Y канваса.
export function confUpdateGabarit(next: Partial<{ length: number; width: number }>): void {
    const f = confState.field;

    // Числа без прямоугольника некуда положить — создаём его под них
    if (!confState.gabarits.length) {
        confState.gabarits.push({
            id: uid(),
            x: snap(f.w * 0.375),
            y: snap(f.h * 0.25),
            w: snap(f.w * 0.25),
            h: snap(f.h * 0.5),
        });
    }

    const g = confState.gabarits[0];
    if (next.width !== undefined) g.w = Math.max(QUANTUM, Math.min(f.w, q(next.width)));
    if (next.length !== undefined) g.h = Math.max(QUANTUM, Math.min(f.h, q(next.length)));

    const c = clampToField(g.x, g.y, g.w, g.h);
    g.x = c.x;
    g.y = c.y;

    confDraw();
    emitConfChange();
}

/** Ставит габарит центром в точку. Второй не создаёт — переносит существующий. */
export function confDropGabarit(wx: number, wy: number): void {
    const f = confState.field;
    let g = confState.gabarits[0];
    if (!g) {
        g = { id: uid(), x: 0, y: 0, w: snap(f.w * 0.25), h: snap(f.h * 0.5) };
        confState.gabarits.push(g);
    }

    const c = clampToField(q(snap(wx) - g.w / 2), q(snap(wy) - g.h / 2), g.w, g.h);
    g.x = c.x;
    g.y = c.y;

    confState.selected = { type: 'gabarit', id: g.id };
    // Инструмент одноразовый: поставил — вернулись к выделению
    confState.tool = 'select';
    confState.placing = null;
    confDraw();
    emitConfChange();
}

/** Центр габарита в метрах поля. Без габарита создаёт его, как правка размеров. */
export function confUpdateGabaritPos(next: Partial<{ cx: number; cy: number }>): void {
    if (!confState.gabarits.length) confUpdateGabarit({});
    const g = confState.gabarits[0];

    const cx = q(next.cx ?? g.x + g.w / 2);
    const cy = q(next.cy ?? g.y + g.h / 2);
    const c = clampToField(q(cx - g.w / 2), q(cy - g.h / 2), g.w, g.h);
    g.x = c.x;
    g.y = c.y;

    confDraw();
    emitConfChange();
}

/** Ставит габарит центром в центр поля; без габарита создаёт его. */
export function confCenterGabarit(): void {
    if (!confState.gabarits.length) confUpdateGabarit({});
    const g = confState.gabarits[0];
    const f = confState.field;

    const c = clampToField(q((f.w - g.w) / 2), q((f.h - g.h) / 2), g.w, g.h);
    g.x = c.x;
    g.y = c.y;

    confState.selected = { type: 'gabarit', id: g.id };
    confDraw();
    emitConfChange();
}

/** Высота машины: вне плоскости поля, на геометрию не влияет. */
export function confUpdateMachineHeight(value: number): void {
    confState.machineHeight = Math.max(0, q(value));
    emitConfChange();
}

export function confToggleCrosshair(on: boolean): void {
    confState.showCrosshair = on;
    confDraw();
    emitConfChange();
}

export function confSelectTool(tool: ConfTool): void {
    confState.tool = tool;
    confState.draft = null;
    // Превью по наведению живёт у инструментов разметки и габарита
    if (tool !== 'zone' && tool !== 'gabarit') confState.placing = null;
    confDraw();
    emitConfChange();
}

export function confSelect(sel: ConfSelection | null): void {
    confState.selected = sel;
    // Выбор из списков панели тоже снимает замер до другого мата
    confState.measureRef = null;
    confDraw();
    emitConfChange();
}

// Свободный номер камеры. Считается по занятым суффиксам, а не по длине списка:
// после удаления средней камеры length + 1 повторил бы существующий ключ, а два
// одинаковых ключа схлопнулись бы в экспорте в одну запись.
function nextCameraIndex(): number {
    let max = 0;
    for (const cam of confState.cameras) {
        const m = /^camera_(\d+)$/.exec(cam.key.trim());
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
}

export function confAddCamera(): void {
    const f = confState.field;
    const w = q(f.w * CAMERA_FRACTION);
    const h = q(f.h * CAMERA_FRACTION);
    const n = nextCameraIndex();

    confState.cameras.push({
        id: uid(),
        key: `camera_${n}`,
        name: `Камера ${n}`,
        x: snap((f.w - w) / 2),
        y: snap((f.h - h) / 2),
        w,
        h,
        color: nextColor('camera'),
    });

    confDraw();
    emitConfChange();
}

/** Создаёт камеру по области, нарисованной инструментом. */
export function confCreateCameraFromRect(rect: Rect): void {
    const n = nextCameraIndex();

    confState.cameras.push({
        id: uid(),
        key: `camera_${n}`,
        name: `Камера ${n}`,
        x: q(rect.x),
        y: q(rect.y),
        w: q(rect.w),
        h: q(rect.h),
        color: nextColor('camera'),
    });

    confState.selected = { type: 'camera', id: confState.cameras[confState.cameras.length - 1].id };
    // Инструмент одноразовый: нарисовал — вернулись к выделению
    confState.tool = 'select';
    confState.draft = null;
    confState.placing = null;
    confDraw();
    emitConfChange();
}

/** Ставит мат верхним левым углом в точку поля. Возвращает причину отказа. */
// Угол, а не центр: он же показывается в подписи выделения и ложится на шаг
// сетки, тогда как центр минус половина мата съезжал бы с неё
export function confPlaceZone(x: number, y: number): string | null {
    const f = confState.field;
    const s = confState.matSize;
    if (!zoneFitsField(s)) {
        return `Мат ${fmtM(s)} м не помещается в поле ${fmtM(f.w)}×${fmtM(f.h)} м`;
    }

    const zone: ConfZone = {
        id: uid(),
        key: `zone_${confState.zones.length + 1}`,
        name: `Зона ${confState.zones.length + 1}`,
        x: q(x),
        y: q(y),
        w: s,
        h: s,
        color: nextColor('zone'),
    };

    clampZoneToField(zone);
    confState.zones.push(zone);
    confState.selected = { type: 'zone', id: zone.id };
    // Инструмент одноразовый: поставил — вернулись к выделению
    confState.tool = 'select';
    confState.draft = null;
    // Иначе превью пережило бы установку и осталось висеть рядом с матом
    confState.placing = null;
    confDraw();
    emitConfChange();
    return null;
}

// Точка курсора, вокруг которой строится превью создаваемого объекта. Точкой
// фиксации не является: меняется на каждый pointermove, панелям знать незачем
export function confSetPlacing(kind: 'zone' | 'camera' | 'gabarit', p: { x: number; y: number } | null): void {
    confState.placing = p ? { kind, x: snap(p.x), y: snap(p.y) } : null;
    confDraw();
}

/** Кладёт мат центром в точку поля. Возвращает причину отказа. */
// Мышью целятся центром, а хранится угол — отсюда перевод. Числами угол
// задаётся напрямую, там перевода нет
export function confDropZone(wx: number, wy: number): string | null {
    const s = confState.matSize;
    return confPlaceZone(q(snap(wx) - s / 2), q(snap(wy) - s / 2));
}

/** Создаёт камеру стандартного размера центром в точку. */
export function confDropCamera(wx: number, wy: number): void {
    const f = confState.field;
    const w = q(f.w * CAMERA_FRACTION);
    const h = q(f.h * CAMERA_FRACTION);
    const c = clampToField(q(snap(wx) - w / 2), q(snap(wy) - h / 2), w, h);
    confCreateCameraFromRect({ x: c.x, y: c.y, w, h });
}

/** Сторона мата в метрах, общая на все зоны. Возвращает причину отказа. */
// Мат мерян рулеткой, поэтому не ужимается под поле: вместо этого
// отклоняется само изменение.
export function confUpdateMatSize(size: number): string | null {
    const s = Math.max(QUANTUM, q(size));
    const f = confState.field;

    if (confState.zones.length && !zoneFitsField(s)) {
        return `Мат ${fmtM(s)} м не помещается в поле ${fmtM(f.w)}×${fmtM(f.h)} м`;
    }

    confState.matSize = s;

    confState.zones.forEach(zone => {
        const cx = zone.x + zone.w / 2;
        const cy = zone.y + zone.h / 2;
        zone.w = s;
        zone.h = s;
        zone.x = q(cx - s / 2);
        zone.y = q(cy - s / 2);
        clampZoneToField(zone);
    });

    confDraw();
    emitConfChange();
    return null;
}

/** Читает файл, вписывает картинку в половину поля и кладёт её на холст. */
export function confAddImageFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            const f = confState.field;
            // Пиксели картинки к метрам не привязаны: вписываем в половину поля
            const fit = Math.min((f.w * 0.5) / img.width, (f.h * 0.5) / img.height);
            const w = q(img.width * fit);
            const h = q(img.height * fit);

            confState.images.push({
                id: uid(),
                name: file.name,
                file,
                x: snap((f.w - w) / 2),
                y: snap((f.h - h) / 2),
                w,
                h,
                img,
            });

            confDraw();
            emitConfChange();
        };
        img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
}

export function confDelete(type: ConfItemType, id: string): void {
    if (type === 'camera') {
        confState.cameras = confState.cameras.filter(c => c.id !== id);
    } else if (type === 'zone') {
        confState.zones = confState.zones.filter(z => z.id !== id);
    } else if (type === 'gabarit') {
        confState.gabarits = confState.gabarits.filter(g => g.id !== id);
    } else {
        confState.images = confState.images.filter(i => i.id !== id);
    }

    if (confState.selected?.id === id) confState.selected = null;
    confDraw();
    emitConfChange();
}

export function confRenameCamera(id: string, patch: Partial<{ key: string; name: string }>): void {
    const cam = confState.cameras.find(c => c.id === id);
    if (!cam) return;
    if (patch.key !== undefined) cam.key = patch.key;
    if (patch.name !== undefined) cam.name = patch.name;
    confDraw();
    emitConfChange();
}
