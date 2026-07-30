import { confState } from '../../state/conf-store';
import { cameraZonesOrdered, zoneRotationFor } from './conf-canvas';

// Сборка и отправка конфигурации birdview.
// Модель редактора метровая, наружу уходят пиксели канваса: всё умножается на
// px_per_m и округляется до целого.

export interface ExportCameraEntry {
    name: string;
    src_points: number[][];
    canvas_region: number[][];
    dst_points: number[][];
}

/**
 * Блок редактора.
 *
 * Геометрия в пресете производная: зоны свалены в общий dst_points и
 * восстанавливаются по четвёркам углов, а имена, шаг сетки и масштаб из неё не
 * следуют. Сервер этот блок не читает и при записи src_points не трогает.
 */
export interface ExportEditorBlock {
    // 2 — геометрия редактора метровая; отсутствие поля означает пиксельную запись
    version: number;
    /** Пикселей канваса на метр: по нему пиксели читаются обратно в метры. */
    px_per_m: number;
    /** Шаг привязки в метрах. */
    step: number;
    /** Имена зон по ключу камеры, в том же порядке, что и четвёрки dst_points. */
    zones: Record<string, string[]>;
}

/**
 * Габарит и реальные метры мира. rect в пикселях канваса экспорта;
 * mat_px — сторона квадрата разметки там же: из пары mat_m/mat_px
 * линкер берёт масштаб мира.
 */
export interface ExportMachineBlock {
    rect?: number[];
    length?: number;
    width?: number;
    height?: number;
    mat_m?: number;
    mat_px?: number;
}

export interface ExportResult {
    name: string;
    canvas: { width: number; height: number };
    cameras: Record<string, ExportCameraEntry>;
    images?: Array<{ name: string; rect: number[] }>;
    machine?: ExportMachineBlock;
    editor?: ExportEditorBlock;
}

export interface ExportParams {
    id: string;
    name: string;
}

/** Итоговый размер растра для показа в панели. */
export function canvasSizePx(): { width: number; height: number } {
    const f = confState.field;
    const ppm = confState.pxPerM;
    return { width: Math.round(f.w * ppm), height: Math.round(f.h * ppm) };
}

export function buildExportJson(params: ExportParams): ExportResult {
    const ppm = confState.pxPerM;
    const f = confState.field;
    const size = canvasSizePx();

    const cameras: Record<string, ExportCameraEntry> = {};
    const zoneNames: Record<string, string[]> = {};

    confState.cameras.forEach(cam => {
        const key = cam.key.trim();
        // Захват на лету: общий мат уходит в dst_points каждой накрывшей камеры.
        // Порядок четвёрок — кольцевой порядок расчёта cameraZonesOrdered
        const camZones = cameraZonesOrdered(cam);
        if (camZones.length) {
            zoneNames[key] = camZones.map(z => z.name);
        }

        const region = [
            [Math.round(cam.x * ppm), Math.round(cam.y * ppm)],
            [Math.round((cam.x + cam.w) * ppm), Math.round(cam.y * ppm)],
            [Math.round((cam.x + cam.w) * ppm), Math.round((cam.y + cam.h) * ppm)],
            [Math.round(cam.x * ppm), Math.round((cam.y + cam.h) * ppm)],
        ];

        const dstPoints: number[][] = [];
        camZones.forEach(zone => {
            const cx = zone.x + zone.w / 2;
            const cy = zone.y + zone.h / 2;
            // Направление мата — своё для каждой камеры, считается на лету
            // от взгляда её значка; мат осевой, поворот кратен 90° и лишь
            // задаёт порядок обхода тех же четырёх углов
            const rad = (zoneRotationFor(cam, zone) * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);

            // Локальные углы в пространстве зоны (до поворота):
            //   tl = (-w/2, -h/2)   tr = (+w/2, -h/2)
            //   bl = (-w/2, +h/2)   br = (+w/2, +h/2)
            //
            // Стрелка указывает «вниз» в локальных координатах (направление +y).
            // «Слева от стрелки» при rotation=0 — это bl (bottom-left).
            //
            // Порядок обхода начинается с bl, далее по часовой:
            //   bl → tl → tr → br
            const localCorners = [
                { lx: -zone.w / 2, ly: zone.h / 2 },  // bl — слева от стрелки
                { lx: -zone.w / 2, ly: -zone.h / 2 }, // tl — слева сверху
                { lx: zone.w / 2, ly: -zone.h / 2 },  // tr — справа сверху
                { lx: zone.w / 2, ly: zone.h / 2 },   // br — справа от стрелки
            ];

            localCorners.forEach(({ lx, ly }) => {
                const rx = cx + lx * cos - ly * sin;
                const ry = cy + lx * sin + ly * cos;
                dstPoints.push([Math.round(rx * ppm), Math.round(ry * ppm)]);
            });
        });

        cameras[key] = {
            name: cam.name,
            src_points: [],
            canvas_region: region,
            dst_points: dstPoints,
        };
    });

    const images = confState.images.map(img => ({
        name: img.name,
        rect: [
            Math.round(img.x * ppm),
            Math.round(img.y * ppm),
            Math.round(img.w * ppm),
            Math.round(img.h * ppm),
        ],
    }));

    const result: ExportResult = {
        name: params.name || params.id,
        canvas: { width: size.width, height: size.height },
        cameras,
        editor: {
            version: 2,
            px_per_m: ppm,
            step: f.step,
            zones: zoneNames,
        },
    };

    if (images.length) result.images = images;

    // Габарит и метры пишутся только заданные: пустой блок не нужен
    const machine: ExportMachineBlock = {};
    const gab = confState.gabarits[0];
    if (gab) {
        machine.rect = [
            Math.round(gab.x * ppm),
            Math.round(gab.y * ppm),
            Math.round(gab.w * ppm),
            Math.round(gab.h * ppm),
        ];
        // Стороны прямоугольника и есть размеры машины: ширина по X, длина по Y
        machine.width = gab.w;
        machine.length = gab.h;
    }
    if (confState.machineHeight > 0) machine.height = confState.machineHeight;
    if (confState.matSize > 0) {
        machine.mat_m = confState.matSize;
        // Мат — тот же квадрат в пикселях канваса, масштаб мира берётся из пары
        machine.mat_px = Math.round(confState.matSize * ppm * 1000) / 1000;
    }
    if (Object.keys(machine).length) result.machine = machine;

    return result;
}

/**
 * Кастомный форматтер: массивы координат [[x,y], ...] сворачиваются
 * в одну пару на строку, иначе превью нечитаемо.
 */
export function formatExportJson(obj: unknown): string {
    const raw = JSON.stringify(obj, null, 2);

    return raw.replace(/\[\s*\n\s*(\[[\s\S]*?\])\s*\n\s*\]/g, match => {
        const pairs: string[] = [];
        const pairRe = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
        let m: RegExpExecArray | null;
        while ((m = pairRe.exec(match)) !== null) {
            pairs.push(`[${m[1]}, ${m[2]}]`);
        }
        if (!pairs.length) return match;
        return '[\n' + pairs.map(p => '            ' + p).join(',\n') + '\n          ]';
    });
}

/** Отправляет конфигурацию вместе с файлами картинок. Бросает при ошибке HTTP. */
export async function saveExport(params: ExportParams): Promise<ExportResult> {
    const result = buildExportJson(params);

    const form = new FormData();
    form.append('config', JSON.stringify({ [params.id]: result }));

    confState.images.forEach(img => {
        if (img.file) form.append('images', img.file, img.name);
    });

    const res = await fetch('/linker/exports', { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

    return result;
}
