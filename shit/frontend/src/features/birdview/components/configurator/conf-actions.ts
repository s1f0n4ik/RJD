import {
    confState,
    emitConfChange,
    nextColor,
    uid,
} from '../../state/conf-store';
import type { ConfItemType, ConfSelection, ConfTool, ConfZone } from '../../types';
import { clampToField, clampZoneToCamera, confDraw, snap } from './conf-canvas';

/**
 * Операции над confState, вызываемые из панели. Порт field.js, cameras.js,
 * zones.js и images.js из no-react.
 *
 * Каждая операция — точка фиксации: мутирует состояние, перерисовывает холст
 * и дёргает emitConfChange.
 */

/** Правка параметров поля. Пережимает все объекты под новые границы. */
export function confUpdateField(next: Partial<{ w: number; h: number; step: number }>): void {
    const step = Math.max(1, next.step ?? confState.field.step);
    const minSize = step * 3;

    confState.field.step = step;
    confState.field.w = Math.max(minSize, next.w ?? confState.field.w);
    confState.field.h = Math.max(minSize, next.h ?? confState.field.h);

    confState.cameras.forEach(cam => {
        if (cam.w > confState.field.w) cam.w = confState.field.w;
        if (cam.h > confState.field.h) cam.h = confState.field.h;
        const c = clampToField(cam.x, cam.y, cam.w, cam.h);
        cam.x = c.x;
        cam.y = c.y;
    });

    confState.zones.forEach(zone => clampZoneToCamera(zone));

    confState.images.forEach(img => {
        if (img.w > confState.field.w) img.w = confState.field.w;
        if (img.h > confState.field.h) img.h = confState.field.h;
        const c = clampToField(img.x, img.y, img.w, img.h);
        img.x = c.x;
        img.y = c.y;
    });

    confState.gabarits.forEach(g => {
        if (g.w > confState.field.w) g.w = confState.field.w;
        if (g.h > confState.field.h) g.h = confState.field.h;
        const c = clampToField(g.x, g.y, g.w, g.h);
        g.x = c.x;
        g.y = c.y;
    });

    confDraw();
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
    const w = snap(Math.round(f.w * 0.25));
    const h = snap(Math.round(f.h * 0.5));
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

/** Реальные метры мира: габарит машины и размер разметочного мата. */
export function confUpdateMachine(
    next: Partial<{ length: number; width: number; height: number; mat: number }>,
): void {
    const m = confState.machine;
    if (next.length !== undefined) m.length = Math.max(0, next.length);
    if (next.width !== undefined) m.width = Math.max(0, next.width);
    if (next.height !== undefined) m.height = Math.max(0, next.height);
    if (next.mat !== undefined) m.mat = Math.max(0, next.mat);
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

export function confAddCamera(): void {
    const f = confState.field;
    const w = Math.round(f.w * 0.3);
    const h = Math.round(f.h * 0.3);
    const n = confState.cameras.length + 1;

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

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Создаёт камеру по области, нарисованной инструментом. */
export function confCreateCameraFromRect(rect: Rect): void {
    const n = confState.cameras.length + 1;

    confState.cameras.push({
        id: uid(),
        key: `camera_${n}`,
        name: `Камера ${n}`,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        color: nextColor('camera'),
    });

    confState.selected = { type: 'camera', id: confState.cameras[confState.cameras.length - 1].id };
    // Инструмент одноразовый: нарисовал — вернулись к выделению
    confState.tool = 'select';
    confState.draft = null;
    confDraw();
    emitConfChange();
}

/** Создаёт зону по области, нарисованной инструментом внутри камеры. */
export function confCreateZoneFromRect(cameraId: string, rect: Rect): void {
    const zone: ConfZone = {
        id: uid(),
        key: `zone_${confState.zones.length + 1}`,
        name: `Зона ${confState.zones.length + 1}`,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        rotation: 0,
        cameraId,
        color: nextColor('zone'),
    };

    clampZoneToCamera(zone);
    confState.zones.push(zone);
    confState.selected = { type: 'zone', id: zone.id };
    // Инструмент одноразовый: нарисовал — вернулись к выделению
    confState.tool = 'select';
    confState.draft = null;
    confDraw();
    emitConfChange();
}

/** Возвращает текст ошибки, если зону добавить не к чему. */
export function confAddZone(): string | null {
    if (!confState.cameras.length) return 'Сначала добавьте камеру';

    const cam =
        confState.selected?.type === 'camera'
            ? confState.cameras.find(c => c.id === confState.selected?.id) ?? confState.cameras[0]
            : confState.cameras[0];

    // Разметка всегда квадратная и одного размера: это физический мат
    const w = Math.min(confState.zoneSize, cam.w, cam.h);
    const h = w;

    const zone: ConfZone = {
        id: uid(),
        key: `zone_${confState.zones.length + 1}`,
        name: `Зона ${confState.zones.length + 1}`,
        x: snap(cam.x + (cam.w - w) / 2),
        y: snap(cam.y + (cam.h - h) / 2),
        w,
        h,
        rotation: 0,
        cameraId: cam.id,
        color: nextColor('zone'),
    };

    clampZoneToCamera(zone);
    confState.zones.push(zone);
    confDraw();
    emitConfChange();
    return null;
}

/** Смена стороны квадрата применяется ко всем зонам сразу, вокруг их центров. */
export function confUpdateZoneSize(size: number): void {
    const s = Math.max(1, Math.round(size));
    confState.zoneSize = s;

    confState.zones.forEach(zone => {
        const cx = zone.x + zone.w / 2;
        const cy = zone.y + zone.h / 2;
        zone.w = s;
        zone.h = s;
        zone.x = Math.round(cx - s / 2);
        zone.y = Math.round(cy - s / 2);
        clampZoneToCamera(zone);
    });

    confDraw();
    emitConfChange();
}

/** Читает файл, вписывает картинку в половину поля и кладёт её на холст. */
export function confAddImageFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            const f = confState.field;
            const scale = Math.min((f.w * 0.5) / img.width, (f.h * 0.5) / img.height, 1);
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);

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
