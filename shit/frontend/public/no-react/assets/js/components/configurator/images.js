'use strict';

import { confState, uid }   from '../../core/conf-state.js';
import { snap, confDraw }   from './canvas.js';
import { renderAllLists }   from './panel.js';

export function confAddImage() {
    document.getElementById('confImgFileInput').click();
}

export function confOnImageFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            const f = confState.field;
            const scale = Math.min(f.w * 0.5 / img.width, f.h * 0.5 / img.height, 1);
            const w = Math.round(img.width  * scale);
            const h = Math.round(img.height * scale);

            confState.images.push({
                id:   uid(),
                name: file.name,
                file: file,
                x:    snap((f.w - w) / 2),
                y:    snap((f.h - h) / 2),
                w, h,
                img,
            });

            confDraw();
            renderAllLists();
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}