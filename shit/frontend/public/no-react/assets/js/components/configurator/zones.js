'use strict';

import { confState, uid, nextColor } from '../../core/conf-state.js';
import { snap, confDraw, clampZoneToCamera } from './canvas.js';
import { renderAllLists } from './panel.js';
import { showToast } from '../../utils/utility.js';

export function confAddZone() {
    if (!confState.cameras.length) {
        showToast('Нет камер', 'Сначала добавьте камеру', 'err');
        return;
    }

    const cam = confState.selected?.type === 'camera'
        ? confState.cameras.find(c => c.id === confState.selected.id)
        : confState.cameras[0];

    let w, h;
    if (confState.fixedZoneSize.enabled) {
        w = confState.fixedZoneSize.w;
        h = confState.fixedZoneSize.h;
    } else {
        w = Math.round(cam.w * 0.4);
        h = Math.round(cam.h * 0.4);
    }

    if (w > cam.w) w = cam.w;
    if (h > cam.h) h = cam.h;

    const zone = {
        id:       uid(),
        key:      `zone_${confState.zones.length + 1}`,
        name:     `Зона ${confState.zones.length + 1}`,
        x:        snap(cam.x + (cam.w - w) / 2),
        y:        snap(cam.y + (cam.h - h) / 2),
        w, h,
        rotation: 0,
        cameraId: cam.id,
        color:    nextColor('zone'),
    };

    clampZoneToCamera(zone);
    confState.zones.push(zone);
    confDraw();
    renderAllLists();
}

export function confToggleFixedZone(enabled) {
    confState.fixedZoneSize.enabled = enabled;
    document.getElementById('confFixedZoneFields').style.display = enabled ? 'flex' : 'none';
}

export function confUpdateFixedZone() {
    confState.fixedZoneSize.w = Math.max(1, +document.getElementById('confFixedZoneW').value || 100);
    confState.fixedZoneSize.h = Math.max(1, +document.getElementById('confFixedZoneH').value || 100);
}