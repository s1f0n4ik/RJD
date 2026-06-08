'use strict';

import { confState } from '../../core/conf-state.js';
import { confDraw, clampToField, clampZoneToCamera } from './canvas.js';

export function confUpdateField() {
    const step = Math.max(1, +document.getElementById('confSnapStep').value || 10);
    const minSize = step * 3;

    confState.field.step = step;
    confState.field.w    = Math.max(minSize, +document.getElementById('confFieldW').value || 1000);
    confState.field.h    = Math.max(minSize, +document.getElementById('confFieldH').value || 1000);

    // Обновить инпуты если были пережаты
    document.getElementById('confFieldW').value = confState.field.w;
    document.getElementById('confFieldH').value = confState.field.h;

    // Clamp все элементы
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

    confDraw();
}