import { useSyncExternalStore } from 'react';
import type {
    ConfCamera,
    ConfGabarit,
    ConfImage,
    ConfItemType,
    ConfSelection,
    ConfTool,
    ConfZone,
} from '../types';

/**
 * Состояние конфигуратора. Это обычный мутируемый объект, а не React-стейт:
 * canvas и pointer-логика правят его напрямую десятки раз в секунду во время
 * drag'а, и гонять такое через реактивность нельзя.
 *
 * React-панели читают его через useConfStore и перерисовываются только когда
 * вызван emitConfChange — то есть в точках фиксации, а не на каждое движение
 * мыши. Список точек фиксации задан в emitConfChange ниже.
 */
export interface ConfState {
    field: { w: number; h: number; step: number };
    tool: ConfTool;

    cameras: ConfCamera[];
    zones: ConfZone[];
    images: ConfImage[];
    /** Массив ради getList и Delete, но габарит один: кнопка не даст второй. */
    gabarits: ConfGabarit[];
    /** Реальные размеры мира в метрах; 0 — не задано. */
    machine: { length: number; width: number; height: number; mat: number };

    selected: ConfSelection | null;
    dragging: { id: string; type: ConfItemType; offsetX: number; offsetY: number } | null;
    rotating: { id: string; type: ConfItemType } | null;
    resize: { id: string; type: ConfItemType; handle: HandleName } | null;

    /**
     * Сторона квадрата разметки в пикселях поля, одна на все зоны.
     * Разметка — физические маты одного размера, поэтому произвольных
     * прямоугольников нет: из этой стороны и «Мат, м» выводится масштаб мира.
     */
    zoneSize: number;
    exportScale: number;

    view: { ox: number; oy: number; scale: number };

    /** Область, которую пользователь растягивает инструментом прямо сейчас. */
    draft: { x: number; y: number; w: number; h: number } | null;

    // Ключ и имя загруженного пресета, предзаполняют экспорт для перезаписи
    presetId: string;
    presetName: string;
}

export type HandleName = 'tl' | 'mt' | 'tr' | 'ml' | 'mr' | 'bl' | 'mb' | 'br';

export const confState: ConfState = {
    field: { w: 1000, h: 1000, step: 10 },
    tool: 'select',

    cameras: [],
    zones: [],
    images: [],
    gabarits: [],
    machine: { length: 0, width: 0, height: 0, mat: 0 },

    selected: null,
    dragging: null,
    rotating: null,
    resize: null,

    zoneSize: 100,
    exportScale: 1,

    view: { ox: 0, oy: 0, scale: 1 },

    draft: null,

    presetId: '',
    presetName: '',
};

export const COLORS: Record<'camera' | 'zone', string[]> = {
    camera: ['#378ADD', '#D85A30', '#1D9E75', '#D4537E', '#BA7517', '#534AB7'],
    zone: ['#85B7EB', '#F0997B', '#5DCAA5', '#ED93B1', '#FAC775', '#AFA9EC'],
};

export const HANDLE_SIZE = 5;
export const ROTATION_STALK = 24;

const colorIdx: Record<'camera' | 'zone', number> = { camera: 0, zone: 0 };

export function nextColor(type: 'camera' | 'zone'): string {
    const arr = COLORS[type];
    const c = arr[colorIdx[type] % arr.length];
    colorIdx[type]++;
    return c;
}

let idCounter = 0;

export function uid(): string {
    return `el_${Date.now()}_${idCounter++}`;
}

/**
 * Внешний стор для useSyncExternalStore.
 *
 * version растёт только при emitConfChange. Панели подписаны на него, canvas —
 * нет, он перерисовывается императивно через confDraw.
 */
const listeners = new Set<() => void>();
let version = 0;

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

function getSnapshot(): number {
    return version;
}

/**
 * Точки фиксации, в которых UI обязан узнать об изменении:
 * создание и удаление объекта, смена выделения, переименование,
 * завершение drag/resize/rotate (pointerup), правка параметров поля.
 *
 * Во время самого drag'а не вызывается — иначе панели будут перерисовываться
 * на каждый pointermove.
 */
export function emitConfChange(): void {
    version++;
    listeners.forEach(fn => fn());
}

/** Подписывает компонент на точки фиксации confState. */
export function useConfStore(): number {
    return useSyncExternalStore(subscribe, getSnapshot);
}

export function getList(type: ConfItemType): Array<ConfCamera | ConfZone | ConfImage | ConfGabarit> {
    if (type === 'camera') return confState.cameras;
    if (type === 'zone') return confState.zones;
    if (type === 'gabarit') return confState.gabarits;
    return confState.images;
}
