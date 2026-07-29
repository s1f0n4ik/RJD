import {
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
    cameraMinSize,
    clampToField,
    clampZoneToCamera,
    confDraw,
    snap,
    zoneFitsCamera,
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

    // Поле ужимает камеры, а камера не может стать меньше своей разметки
    for (const cam of confState.cameras) {
        const min = cameraMinSize(cam.id);
        if (min.w > w || min.h > h) {
            return `Камера «${cam.name}» держит разметку ${fmtM(min.w)}×${fmtM(min.h)} м — поле меньше не станет`;
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

    confState.zones.forEach(zone => clampZoneToCamera(zone));

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

/** Высота машины: вне плоскости поля, на геометрию не влияет. */
export function confUpdateMachineHeight(value: number): void {
    confState.machineHeight = Math.max(0, q(value));
    emitConfChange();
}

export function confSelectTool(tool: ConfTool): void {
    confState.tool = tool;
    confState.draft = null;
    confDraw();
    emitConfChange();
}

export function confSelect(sel: ConfSelection | null): void {
    confState.selected = sel;
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
    const w = q(f.w * 0.3);
    const h = q(f.h * 0.3);
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
    confDraw();
    emitConfChange();
}

/** Ставит мат центром в точку внутри камеры. Возвращает причину отказа. */
export function confPlaceZone(cameraId: string, cx: number, cy: number): string | null {
    const cam = confState.cameras.find(c => c.id === cameraId);
    if (!cam) return 'Камера не найдена';

    const s = confState.matSize;
    if (!zoneFitsCamera(cam, s, 0)) {
        return `Мат ${fmtM(s)} м не помещается в камеру «${cam.name}» ${fmtM(cam.w)}×${fmtM(cam.h)} м`;
    }

    const zone: ConfZone = {
        id: uid(),
        key: `zone_${confState.zones.length + 1}`,
        name: `Зона ${confState.zones.length + 1}`,
        x: q(cx - s / 2),
        y: q(cy - s / 2),
        w: s,
        h: s,
        rotation: 0,
        cameraId,
        color: nextColor('zone'),
    };

    clampZoneToCamera(zone);
    confState.zones.push(zone);
    confState.selected = { type: 'zone', id: zone.id };
    // Инструмент одноразовый: поставил — вернулись к выделению
    confState.tool = 'select';
    confState.draft = null;
    confDraw();
    emitConfChange();
    return null;
}

/** Возвращает текст ошибки, если мат добавить некуда. */
export function confAddZone(): string | null {
    if (!confState.cameras.length) return 'Сначала добавьте камеру';

    const cam =
        confState.selected?.type === 'camera'
            ? confState.cameras.find(c => c.id === confState.selected?.id) ?? confState.cameras[0]
            : confState.cameras[0];

    return confPlaceZone(cam.id, cam.x + cam.w / 2, cam.y + cam.h / 2);
}

/** Сторона мата в метрах, общая на все зоны. Возвращает причину отказа. */
// Мат мерян рулеткой, поэтому не ужимается под камеру: вместо этого
// отклоняется само изменение.
export function confUpdateMatSize(size: number): string | null {
    const s = Math.max(QUANTUM, q(size));

    for (const zone of confState.zones) {
        const cam = confState.cameras.find(c => c.id === zone.cameraId);
        if (cam && !zoneFitsCamera(cam, s, zone.rotation)) {
            return `Мат ${fmtM(s)} м не помещается в камеру «${cam.name}» ${fmtM(cam.w)}×${fmtM(cam.h)} м`;
        }
    }

    confState.matSize = s;

    confState.zones.forEach(zone => {
        const cx = zone.x + zone.w / 2;
        const cy = zone.y + zone.h / 2;
        zone.w = s;
        zone.h = s;
        zone.x = q(cx - s / 2);
        zone.y = q(cy - s / 2);
        clampZoneToCamera(zone);
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
        confState.zones = confState.zones.filter(z => z.cameraId !== id);
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
