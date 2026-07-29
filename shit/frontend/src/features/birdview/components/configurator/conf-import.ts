import {
    confState,
    DEFAULT_MAT,
    DEFAULT_STEP,
    emitConfChange,
    nextColor,
    q,
    QUANTUM,
} from '../../state/conf-store';
import type { ConfCamera, ConfGabarit, ConfImage, ConfZone } from '../../types';
import { clampZoneToCamera } from './conf-canvas';

// Разбор пресета обратно в модель редактора.
// Экспорт хранит производную геометрию в пикселях канваса: камера —
// прямоугольником углов canvas_region, а все её зоны свалены в один dst_points
// четвёрками bl → tl → tr → br. Здесь всё делится на px_per_m и становится
// метрами.

interface PresetJson {
    name?: string;
    canvas?: { width?: number; height?: number };
    cameras?: Record<string, PresetCameraJson>;
    images?: Array<{ name?: string; rect?: number[] }>;
    /** Габарит машины и реальные метры мира. */
    machine?: {
        rect?: number[];
        length?: number;
        width?: number;
        height?: number;
        mat_m?: number;
        mat_px?: number;
    };
    /** Блок редактора: то, чего нет в производной геометрии. */
    editor?: { version?: number; px_per_m?: number; step?: number; zones?: Record<string, string[]> };
}

interface PresetCameraJson {
    name?: string;
    canvas_region?: number[][];
    dst_points?: number[][];
}

export interface ImportResult {
    cameras: number;
    zones: number;
    images: number;
    /** Подложки, которых не нашлось на сервере. */
    missingImages: string[];
}

function num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// Пикселей канваса на метр. Порядок повторяет surround-bake: сначала мат, он
// мерян рулеткой и точнее ректа, потом длина машины по высоте ректа.
function resolvePxPerM(preset: PresetJson): number {
    // Квантуется так же, как ручка в панели: деление даёт хвосты вроде
    // 100 / 0.11 = 909.0909090909091, и они бы уехали прямо в поле ввода
    const use = (v: number): number => Math.max(QUANTUM, q(v));

    const declared = num(preset.editor?.px_per_m);
    if (declared > 0) return use(declared);

    const m = preset.machine;
    const matM = num(m?.mat_m);
    const matPx = num(m?.mat_px);
    if (matM > 0 && matPx > 0) return use(matPx / matM);

    const rect = Array.isArray(m?.rect) && m.rect.length >= 4 ? m.rect : null;
    const length = num(m?.length);
    if (rect && num(rect[3]) > 0 && length > 0) return use(num(rect[3]) / length);

    throw new Error('в записи нет ни масштаба, ни мата, ни габарита — метры восстановить нечем');
}

function boundsOf(points: number[][]): { x: number; y: number; w: number; h: number } | null {
    const valid = points.filter(p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite));
    if (valid.length === 0) return null;

    const xs = valid.map(p => p[0]);
    const ys = valid.map(p => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Четвёрка углов bl → tl → tr → br обратно в прямоугольник с поворотом. */
function zoneFromCorners(corners: number[][]): { x: number; y: number; w: number; h: number; rotation: number } | null {
    if (corners.length < 4) return null;
    if (!corners.every(p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite))) return null;

    const [bl, tl, tr] = corners;

    const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    if (w <= 0 || h <= 0) return null;

    const cx = corners.reduce((s, p) => s + p[0], 0) / 4;
    const cy = corners.reduce((s, p) => s + p[1], 0) / 4;

    // Вектор tl → tr — это направление ширины, то есть локальная ось x
    const deg = (Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180) / Math.PI;
    const rotation = ((Math.round(deg) % 360) + 360) % 360;

    return { x: cx - w / 2, y: cy - h / 2, w, h, rotation };
}

let seq = 0;
function makeId(prefix: string): string {
    seq += 1;
    return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

/**
 * Загрузка подложки с сервера обратно в редактор.
 *
 * Редактору нужен File: при сохранении картинки уходят в FormData тем же
 * путём, что и добавленные вручную.
 */
async function fetchOverlay(
    name: string,
    rect: { x: number; y: number; w: number; h: number },
): Promise<ConfImage | null> {
    const res = await fetch(`/linker/image?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;

    const blob = await res.blob();
    const file = new File([blob], name, { type: blob.type || 'image/png' });
    const url = URL.createObjectURL(blob);

    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error(`не удалось прочитать ${name}`));
            el.src = url;
        });

        return {
            id: makeId('img'),
            name,
            file,
            img,
            ...rect,
        };
    } catch {
        return null;
    } finally {
        // Картинка уже декодирована, ссылка больше не нужна
        URL.revokeObjectURL(url);
    }
}

/**
 * Полная замена содержимого поля. Слияние не предлагаем: ключи камер в двух
 * пресетах совпадут, и разобрать потом, что откуда, будет нельзя.
 */
export async function importPreset(preset: PresetJson): Promise<ImportResult> {
    const ppm = resolvePxPerM(preset);
    const toM = (px: number): number => q(px / ppm);

    const width = num(preset.canvas?.width) > 0 ? toM(num(preset.canvas?.width)) : confState.field.w;
    const height = num(preset.canvas?.height) > 0 ? toM(num(preset.canvas?.height)) : confState.field.h;

    const cameras: ConfCamera[] = [];
    const zones: ConfZone[] = [];

    for (const [key, cam] of Object.entries(preset.cameras ?? {})) {
        const region = Array.isArray(cam?.canvas_region) ? boundsOf(cam.canvas_region) : null;
        if (!region) continue;

        const cameraId = makeId('cam');
        cameras.push({
            id: cameraId,
            key,
            name: cam?.name || key,
            color: nextColor('camera'),
            x: toM(region.x),
            y: toM(region.y),
            w: toM(region.w),
            h: toM(region.h),
        });

        const dst = Array.isArray(cam?.dst_points) ? cam.dst_points : [];
        const savedNames = preset.editor?.zones?.[key] ?? [];

        for (let i = 0; i + 3 < dst.length; i += 4) {
            const shape = zoneFromCorners(dst.slice(i, i + 4));
            if (!shape) continue;

            const index = i / 4;
            zones.push({
                id: makeId('zone'),
                key: `${key}_${index + 1}`,
                name: savedNames[index] || `Зона ${index + 1}`,
                cameraId,
                color: nextColor('zone'),
                x: toM(shape.x),
                y: toM(shape.y),
                w: toM(shape.w),
                h: toM(shape.h),
                rotation: shape.rotation,
            });
        }
    }

    confState.pxPerM = ppm;
    confState.field = { ...confState.field, w: width, h: height };

    // До версии 2 шаг записан в пикселях канваса, начиная с неё — в метрах
    const version = num(preset.editor?.version);
    const rawStep = num(preset.editor?.step);
    if (rawStep > 0) {
        confState.field.step = version >= 2 ? q(rawStep) : toM(rawStep);
    } else {
        confState.field.step = DEFAULT_STEP;
    }

    // Подложки тянем параллельно: их единицы, а последовательно это заметная пауза
    const overlays = await Promise.all(
        (preset.images ?? []).map(async img => {
            const name = String(img?.name ?? '');
            const rect = Array.isArray(img?.rect) && img.rect.length >= 4 ? img.rect : null;
            if (!name || !rect || !rect.every(Number.isFinite)) return { name, image: null };

            const image = await fetchOverlay(name, {
                x: toM(rect[0]),
                y: toM(rect[1]),
                w: toM(rect[2]),
                h: toM(rect[3]),
            }).catch(() => null);

            return { name, image };
        }),
    );

    const images = overlays
        .map(o => o.image)
        .filter((img): img is ConfImage => img !== null);
    const missingImages = overlays.filter(o => o.image === null).map(o => o.name);

    // Габарит: размер из точных метров length/width, из ректа только положение
    const mach = preset.machine;
    const rect = Array.isArray(mach?.rect) && mach.rect.length >= 4 && mach.rect.every(Number.isFinite)
        ? mach.rect
        : null;
    const machW = num(mach?.width);
    const machL = num(mach?.length);

    const gabW = machW > 0 ? q(machW) : rect ? toM(rect[2]) : 0;
    const gabH = machL > 0 ? q(machL) : rect ? toM(rect[3]) : 0;

    const gabarits: ConfGabarit[] = [];
    if (gabW > 0 && gabH > 0) {
        gabarits.push({
            id: makeId('gab'),
            x: rect ? toM(rect[0]) : q((width - gabW) / 2),
            y: rect ? toM(rect[1]) : q((height - gabH) / 2),
            w: gabW,
            h: gabH,
        });
    }
    confState.gabarits = gabarits;
    confState.machineHeight = num(mach?.height) > 0 ? q(num(mach?.height)) : 0;

    confState.cameras = cameras;
    confState.zones = zones;
    confState.images = images;

    // Разметка всегда квадратная и одного размера. Сторона берётся из мерянного
    // mat_m, иначе из первой зоны: прежние записи несли прямоугольники.
    const matM = num(mach?.mat_m);
    if (matM > 0) {
        confState.matSize = q(matM);
    } else if (zones.length) {
        confState.matSize = Math.max(q(zones[0].w), 0.001);
    } else {
        confState.matSize = DEFAULT_MAT;
    }

    const mat = confState.matSize;
    zones.forEach(zone => {
        const cx = zone.x + zone.w / 2;
        const cy = zone.y + zone.h / 2;
        zone.w = mat;
        zone.h = mat;
        zone.x = q(cx - mat / 2);
        zone.y = q(cy - mat / 2);
        clampZoneToCamera(zone);
    });

    confState.selected = null;
    confState.dragging = null;
    confState.rotating = null;
    confState.resize = null;
    confState.draft = null;
    confState.tool = 'select';

    emitConfChange();

    return {
        cameras: cameras.length,
        zones: zones.length,
        images: images.length,
        missingImages,
    };
}
