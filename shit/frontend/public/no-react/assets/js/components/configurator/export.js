'use strict';

import { confState } from '../../core/conf-state.js';
import { showToast } from '../../utils/utility.js';

export function confOpenExport() {
    document.getElementById('confExportScale').value = 1;
    document.getElementById('confExportId').value    = '';
    document.getElementById('confExportName').value  = '';
    confUpdateExportPreview();
    document.getElementById('confExportModal').style.display = 'flex';
}

export function confCloseExport(e) {
    if (e && e.target !== document.getElementById('confExportModal')) return;
    document.getElementById('confExportModal').style.display = 'none';
}

function _buildExportJson() {
    const scale = Math.max(0.1, +document.getElementById('confExportScale').value || 1);
    const id    = document.getElementById('confExportId').value.trim();
    const name  = document.getElementById('confExportName').value.trim();

    const f  = confState.field;
    const cw = Math.round(f.w * scale);
    const ch = Math.round(f.h * scale);
    const s  = scale;

    const cameras = {};
    confState.cameras.forEach(cam => {
        const camZones = confState.zones.filter(z => z.cameraId === cam.id);

        const region = [
            [Math.round(cam.x * s), Math.round(cam.y * s)],
            [Math.round((cam.x + cam.w) * s), Math.round(cam.y * s)],
            [Math.round((cam.x + cam.w) * s), Math.round((cam.y + cam.h) * s)],
            [Math.round(cam.x * s), Math.round((cam.y + cam.h) * s)],
        ];

        const dstPoints = [];
        camZones.forEach(zone => {
            const cx  = zone.x + zone.w / 2;
            const cy  = zone.y + zone.h / 2;
            const rad = zone.rotation * Math.PI / 180;
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
                { lx: -zone.w / 2, ly:  zone.h / 2 },  // bl — слева от стрелки
                { lx: -zone.w / 2, ly: -zone.h / 2 },  // tl — слева сверху
                { lx:  zone.w / 2, ly: -zone.h / 2 },  // tr — справа сверху
                { lx:  zone.w / 2, ly:  zone.h / 2 },  // br — справа от стрелки
            ];

            localCorners.forEach(({ lx, ly }) => {
                const rx = cx + lx * cos - ly * sin;
                const ry = cy + lx * sin + ly * cos;
                dstPoints.push([Math.round(rx * s), Math.round(ry * s)]);
            });
        });

        cameras[cam.key] = {
            name:          cam.name,
            src_points:    [],
            canvas_region: region,
            dst_points:    dstPoints,
        };
    });

    const images = confState.images.map(img => ({
        name: img.name,
        rect: [
            Math.round(img.x * s), Math.round(img.y * s),
            Math.round(img.w * s), Math.round(img.h * s),
        ],
    }));

    const result = {
        name:    name || id,
        canvas:  { width: cw, height: ch },
        cameras: cameras,
    };

    if (images.length) result.images = images;

    return { id, result };
}

function _formatExportJson(obj) {
    // Кастомный форматтер: массивы координат [[x,y], ...] — по одной паре на строку
    const raw = JSON.stringify(obj, null, 2);

    // Заменяем многострочные массивы вида [\n  [\n    x,\n    y\n  ],\n  ...] на компактные
    return raw.replace(
        /\[\s*\n\s*(\[[\s\S]*?\])\s*\n\s*\]/g,
        (match) => {
            // Собрать все [x, y] внутри
            const pairs = [];
            const pairRe = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
            let m;
            while ((m = pairRe.exec(match)) !== null) {
                pairs.push(`[${m[1]}, ${m[2]}]`);
            }
            if (!pairs.length) return match;
            return '[\n' + pairs.map(p => '            ' + p).join(',\n') + '\n          ]';
        }
    );
}

export function confUpdateExportPreview() {
    const scale = Math.max(0.1, +document.getElementById('confExportScale').value || 1);
    const f = confState.field;
    document.getElementById('confExportCanvasSize').textContent =
        `${Math.round(f.w * scale)} × ${Math.round(f.h * scale)} px`;

    const { result } = _buildExportJson();
    document.getElementById('confExportPreview').textContent = _formatExportJson(result);
}

export async function confSaveExport() {
    const { id, result } = _buildExportJson();

    if (!id) {
        showToast('ID не указан', 'Заполните поле ID конфигурации', 'err');
        return;
    }

    // Собрать всё в FormData: JSON + файлы изображений
    const form = new FormData();

    const payload = {};
    payload[id] = result;
    form.append('config', JSON.stringify(payload));

    // Прикрепить файлы изображений
    confState.images.forEach(img => {
        if (img.file) {
            form.append('images', img.file, img.name);
        }
    });

    try {
        //let url = "http://192.168.1.2:7777/linker/exports"
        let url = "/linker/exports"
        const res = await fetch(url, {
            method: 'POST',
            body:   form,
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

        confCloseExport();
        showToast('Конфигурация сохранена', `${id} · ${result.name}`, 'ok');

    } catch (err) {
        showToast('Ошибка сохранения', err.message, 'err');
        console.error('confSaveExport:', err);
    }
}