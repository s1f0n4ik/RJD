import { confState, emitConfChange, nextColor } from '../../state/conf-store';
import type { ConfCamera, ConfImage, ConfZone } from '../../types';

/**
 * Разбор пресета обратно в модель редактора.
 *
 * Экспорт хранит производную геометрию: камера — прямоугольником углов
 * canvas_region, а все её зоны свалены в один dst_points четвёрками. Четвёрка
 * идёт в порядке bl → tl → tr → br, и по ней однозначно восстанавливаются
 * центр, размеры и поворот. Имена зон в пресете не хранятся — конфигуратор
 * пишет их с версии, где появился этот разбор, а у прежних записей их нет.
 */

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
    };
    /** Блок редактора: то, чего нет в производной геометрии. */
    editor?: { step?: number; zones?: Record<string, string[]> };
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
function zoneFromCorners(corners: number[][]): Omit<ConfZone, 'id' | 'key' | 'name' | 'cameraId' | 'color'> | null {
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
 * путём, что и добавленные вручную. Поэтому тянем байты и собираем File из
 * них — иначе после правки пресета подложки бы из него пропали.
 */
async function fetchOverlay(name: string, rect: { x: number; y: number; w: number; h: number }): Promise<ConfImage | null> {
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
    const width = Number(preset.canvas?.width) || confState.field.w;
    const height = Number(preset.canvas?.height) || confState.field.h;

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
            ...region,
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
                ...shape,
            });
        }
    }

    confState.field = { ...confState.field, w: width, h: height };
    if (preset.editor?.step && Number.isFinite(preset.editor.step)) {
        confState.field.step = Number(preset.editor.step);
    }

    // Подложки тянем параллельно: их единицы, а последовательно это заметная пауза
    const overlays = await Promise.all(
        (preset.images ?? []).map(async img => {
            const name = String(img?.name ?? '');
            const rect = Array.isArray(img?.rect) && img.rect.length >= 4 ? img.rect : null;
            if (!name || !rect || !rect.every(Number.isFinite)) return { name, image: null };

            const image = await fetchOverlay(name, {
                x: rect[0],
                y: rect[1],
                w: rect[2],
                h: rect[3],
            }).catch(() => null);

            return { name, image };
        }),
    );

    const images = overlays
        .map(o => o.image)
        .filter((img): img is ConfImage => img !== null);
    const missingImages = overlays.filter(o => o.image === null).map(o => o.name);

    // Габарит и метры: без блока сбрасываются, а не остаются от прошлого пресета
    const mach = preset.machine;
    const rect = Array.isArray(mach?.rect) && mach.rect.length >= 4
        && mach.rect.every(Number.isFinite)
        ? mach.rect
        : null;
    confState.gabarits = rect
        ? [{ id: makeId('gab'), x: rect[0], y: rect[1], w: rect[2], h: rect[3] }]
        : [];
    confState.machine = {
        length: Number(mach?.length) > 0 ? Number(mach?.length) : 0,
        width: Number(mach?.width) > 0 ? Number(mach?.width) : 0,
        height: Number(mach?.height) > 0 ? Number(mach?.height) : 0,
        mat: Number(mach?.mat_m) > 0 ? Number(mach?.mat_m) : 0,
    };

    confState.cameras = cameras;
    confState.zones = zones;
    confState.images = images;

    /*
        Разметка всегда квадратная и одного размера. Пресеты старше этого
        правила могли нести прямоугольники: общий размер берётся из первой
        зоны, остальные приводятся к нему вокруг своих центров.
    */
    if (zones.length) {
        confState.zoneSize = Math.max(1, Math.round(zones[0].w));
        zones.forEach(zone => {
            const cx = zone.x + zone.w / 2;
            const cy = zone.y + zone.h / 2;
            zone.w = confState.zoneSize;
            zone.h = confState.zoneSize;
            zone.x = Math.round(cx - confState.zoneSize / 2);
            zone.y = Math.round(cy - confState.zoneSize / 2);
        });
    }
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
