import { confState } from '../../state/conf-store';

/**
 * Сборка и отправка конфигурации birdview. Порт export.js из no-react.
 * Логика построения геометрии не менялась.
 */

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
 * восстанавливаются по четвёркам углов, а имена и шаг сетки из неё не следуют.
 * Сервер этот блок не читает и при записи src_points не трогает — save_preset
 * правит запись точечно, а не пересобирает её.
 */
export interface ExportEditorBlock {
    step: number;
    /** Имена зон по ключу камеры, в том же порядке, что и четвёрки dst_points. */
    zones: Record<string, string[]>;
}

/**
 * Габарит и реальные метры мира. rect в пикселях канваса экспорта;
 * mat_px — шаг разметки там же: из пары mat_m/mat_px линкер берёт масштаб.
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
    scale: number;
}

export function buildExportJson(params: ExportParams): ExportResult {
    const s = Math.max(0.1, params.scale || 1);
    const f = confState.field;
    const cw = Math.round(f.w * s);
    const ch = Math.round(f.h * s);

    const cameras: Record<string, ExportCameraEntry> = {};
    const zoneNames: Record<string, string[]> = {};

    confState.cameras.forEach(cam => {
        const camZones = confState.zones.filter(z => z.cameraId === cam.id);
        if (camZones.length) {
            zoneNames[cam.key] = camZones.map(z => z.name);
        }

        const region = [
            [Math.round(cam.x * s), Math.round(cam.y * s)],
            [Math.round((cam.x + cam.w) * s), Math.round(cam.y * s)],
            [Math.round((cam.x + cam.w) * s), Math.round((cam.y + cam.h) * s)],
            [Math.round(cam.x * s), Math.round((cam.y + cam.h) * s)],
        ];

        const dstPoints: number[][] = [];
        camZones.forEach(zone => {
            const cx = zone.x + zone.w / 2;
            const cy = zone.y + zone.h / 2;
            const rad = (zone.rotation * Math.PI) / 180;
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
            // После поворота это даёт: «лево-низ от стрелки» → «право-низ» → «право-верх» → «лево-верх»
            const localCorners = [
                { lx: -zone.w / 2, ly: zone.h / 2 },  // bl — слева от стрелки
                { lx: -zone.w / 2, ly: -zone.h / 2 }, // tl — слева сверху
                { lx: zone.w / 2, ly: -zone.h / 2 },  // tr — справа сверху
                { lx: zone.w / 2, ly: zone.h / 2 },   // br — справа от стрелки
            ];

            localCorners.forEach(({ lx, ly }) => {
                const rx = cx + lx * cos - ly * sin;
                const ry = cy + lx * sin + ly * cos;
                dstPoints.push([Math.round(rx * s), Math.round(ry * s)]);
            });
        });

        cameras[cam.key] = {
            name: cam.name,
            src_points: [],
            canvas_region: region,
            dst_points: dstPoints,
        };
    });

    const images = confState.images.map(img => ({
        name: img.name,
        rect: [
            Math.round(img.x * s),
            Math.round(img.y * s),
            Math.round(img.w * s),
            Math.round(img.h * s),
        ],
    }));

    const result: ExportResult = {
        name: params.name || params.id,
        canvas: { width: cw, height: ch },
        cameras,
        editor: { step: f.step, zones: zoneNames },
    };

    if (images.length) result.images = images;

    // Габарит и метры пишутся только заданные: пустой блок не нужен
    const machine: ExportMachineBlock = {};
    const gab = confState.gabarits[0];
    if (gab) {
        machine.rect = [
            Math.round(gab.x * s),
            Math.round(gab.y * s),
            Math.round(gab.w * s),
            Math.round(gab.h * s),
        ];
    }
    const m = confState.machine;
    if (m.length > 0) machine.length = m.length;
    if (m.width > 0) machine.width = m.width;
    if (m.height > 0) machine.height = m.height;
    if (m.mat > 0) {
        machine.mat_m = m.mat;
        machine.mat_px = f.step * s;
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
