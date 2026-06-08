'use strict';

import { confState, uid, nextColor } from '../../core/conf-state.js';
import { snap, confDraw }            from './canvas.js';
import { renderAllLists }            from './panel.js';

export function confAddCamera() {
    const f = confState.field;
    const w = Math.round(f.w * 0.3);
    const h = Math.round(f.h * 0.3);
    const n = confState.cameras.length + 1;

    confState.cameras.push({
        id:    uid(),
        key:   `camera_${n}`,
        name:  `Камера ${n}`,
        x: snap((f.w - w) / 2),
        y: snap((f.h - h) / 2),
        w, h,
        color: nextColor('camera'),
    });

    confDraw();
    renderAllLists();
}