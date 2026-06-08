'use strict';

import { confState } from '../../core/conf-state.js';
import { confDraw }  from './canvas.js';

let _panelOpen = false;

export function confTogglePanel() {
    _panelOpen = !_panelOpen;
    document.getElementById('confPanel').classList.toggle('open', _panelOpen);
    document.getElementById('confPanelTab').classList.toggle('open', _panelOpen);
}

export function confSelectTool(tool) {
    confState.tool = tool;
    document.querySelectorAll('.conf-tool-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tool === tool));
}

export function renderAllLists() {
    _renderCamList();
    _renderZoneList();
    _renderImgList();
}

function _renderCamList() {
    const list = document.getElementById('confCamList');
    list.innerHTML = '';
    document.getElementById('confCamCount').textContent = confState.cameras.length;

    confState.cameras.forEach(cam => {
        const isSelected = confState.selected?.id === cam.id;
        const el = document.createElement('div');
        el.className = 'conf-item-wrap';

        el.innerHTML = `
            <div class="conf-item ${isSelected ? 'selected' : ''}">
                <div class="conf-item-color" style="background:${cam.color}"></div>
                <span class="conf-item-name">${cam.name}</span>
                <span class="conf-item-meta">${cam.w}×${cam.h}</span>
                <button class="conf-item-delete" data-id="${cam.id}">✕</button>
            </div>
            ${isSelected ? `
            <div class="conf-item-edit">
                <div class="field-row">
                    <div class="field-group">
                        <label class="field-label">Ключ</label>
                        <input class="field-input conf-edit-key" type="text"
                               value="${cam.key}" data-id="${cam.id}" />
                    </div>
                    <div class="field-group">
                        <label class="field-label">Имя</label>
                        <input class="field-input conf-edit-name" type="text"
                               value="${cam.name}" data-id="${cam.id}" />
                    </div>
                </div>
            </div>` : ''}
        `;

        // Клик по элементу — выбор
        el.querySelector('.conf-item').onclick = (e) => {
            if (e.target.classList.contains('conf-item-delete')) {
                _deleteCamera(cam.id);
                return;
            }
            confState.selected = { type: 'camera', id: cam.id };
            confDraw();
            renderAllLists();
        };

        // Редактирование полей
        if (isSelected) {
            const keyInput  = el.querySelector('.conf-edit-key');
            const nameInput = el.querySelector('.conf-edit-name');

            keyInput?.addEventListener('input', (e) => {
                cam.key = e.target.value.trim();
            });
            nameInput?.addEventListener('input', (e) => {
                cam.name = e.target.value.trim();
                confDraw();
                _renderZoneList(); // обновить отображение имени камеры в зонах
            });
        }

        list.appendChild(el);
    });
}

function _deleteCamera(camId) {
    confState.cameras = confState.cameras.filter(c => c.id !== camId);
    confState.zones   = confState.zones.filter(z => z.cameraId !== camId);
    if (confState.selected?.id === camId) confState.selected = null;
    confDraw();
    renderAllLists();
}

function _renderZoneList() {
    const list = document.getElementById('confZoneList');
    list.innerHTML = '';
    document.getElementById('confZoneCount').textContent = confState.zones.length;

    confState.zones.forEach(zone => {
        const cam = confState.cameras.find(c => c.id === zone.cameraId);
        const camZones = confState.zones.filter(z => z.cameraId === zone.cameraId);
        const indexInCam = camZones.indexOf(zone) + 1;

        const el = document.createElement('div');
        el.className = 'conf-item' + (confState.selected?.id === zone.id ? ' selected' : '');
        el.innerHTML = `
            <div class="conf-item-color" style="background:${zone.color}"></div>
            <div class="conf-item-name-col">
                <span class="conf-item-name">${zone.name}</span>
                <span class="conf-item-cam-tag" style="border-color:${cam?.color ?? 'var(--border)'}; color:${cam?.color ?? 'var(--text-dim)'}">
                    #${indexInCam} · ${cam?.name ?? '—'}
                </span>
            </div>
            <span class="conf-item-meta">${zone.rotation}°</span>
            <button class="conf-item-delete" data-id="${zone.id}">✕</button>
        `;
        el.onclick = (e) => {
            if (e.target.classList.contains('conf-item-delete')) {
                confState.zones = confState.zones.filter(z => z.id !== zone.id);
                if (confState.selected?.id === zone.id) confState.selected = null;
                confDraw();
                renderAllLists();
                return;
            }
            confState.selected = { type: 'zone', id: zone.id };
            confDraw();
            renderAllLists();
        };
        list.appendChild(el);
    });
}

function _renderImgList() {
    const list = document.getElementById('confImgList');
    list.innerHTML = '';
    document.getElementById('confImgCount').textContent = confState.images.length;

    confState.images.forEach(img => {
        const el = document.createElement('div');
        el.className = 'conf-item' + (confState.selected?.id === img.id ? ' selected' : '');
        el.innerHTML = `
            <span class="conf-item-name">${img.name}</span>
            <span class="conf-item-meta">${img.w}×${img.h}</span>
            <button class="conf-item-delete" data-id="${img.id}">✕</button>
        `;
        el.onclick = (e) => {
            if (e.target.classList.contains('conf-item-delete')) {
                confState.images = confState.images.filter(i => i.id !== img.id);
                if (confState.selected?.id === img.id) confState.selected = null;
                confDraw();
                renderAllLists();
                return;
            }
            confState.selected = { type: 'image', id: img.id };
            confDraw();
            renderAllLists();
        };
        list.appendChild(el);
    });
}