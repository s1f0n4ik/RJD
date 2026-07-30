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

// Состояние конфигуратора. Обычный мутируемый объект, а не React-стейт: canvas и
// pointer-логика правят его напрямую десятки раз в секунду во время drag'а.
// React-панели читают его через useConfStore и перерисовываются только по
// emitConfChange, то есть в точках фиксации.
// Все линейные величины здесь — метры. Пиксели появляются только в conf-export.
export interface ConfState {
    field: { w: number; h: number; step: number };
    // Пикселей канваса экспорта на один метр поля
    pxPerM: number;
    tool: ConfTool;

    cameras: ConfCamera[];
    zones: ConfZone[];
    images: ConfImage[];
    // Габарит один: w — ширина машины вдоль X, h — длина вдоль Y
    gabarits: ConfGabarit[];
    // Высота машины, м; в плоскости поля не участвует
    machineHeight: number;
    // Сторона квадрата разметки, м; одна на все зоны
    matSize: number;

    selected: ConfSelection | null;
    // Мат, до которого мерятся расстояния вместо габарита. fromId — мат, от
    // которого замер начали: пока выделен не он, ссылка недействительна
    measureRef: { fromId: string; toId: string } | null;
    dragging: { id: string; type: ConfItemType; offsetX: number; offsetY: number } | null;
    resize: { id: string; type: ConfItemType; handle: HandleName } | null;

    view: { ox: number; oy: number; scale: number };

    // Область, которую пользователь растягивает инструментом прямо сейчас
    draft: { x: number; y: number; w: number; h: number } | null;

    // Точка, куда ляжет создаваемый объект: по ней ведётся превью. Ставится
    // перетаскиванием из панели и наведением инструментов разметки и габарита
    placing: { kind: 'zone' | 'camera' | 'gabarit'; x: number; y: number } | null;

    // Перекрестие через весь холст в точке курсора, по узлам шага привязки
    showCrosshair: boolean;
    // Курсор в метрах поля; null — указатель вне холста
    cursor: { x: number; y: number } | null;

    // Ключ и имя загруженного пресета, предзаполняют экспорт для перезаписи
    presetId: string;
    presetName: string;
}

export type HandleName = 'tl' | 'mt' | 'tr' | 'ml' | 'mr' | 'bl' | 'mb' | 'br';

// Квант хранения линейных величин, м
export const QUANTUM = 0.001;

export const DEFAULT_FIELD_W = 10;
export const DEFAULT_FIELD_H = 10;
export const DEFAULT_STEP = 0.1;
export const DEFAULT_PX_PER_M = 100;
export const DEFAULT_MAT = 1;

// Доля поля, которую занимает новая камера
export const CAMERA_FRACTION = 0.3;

export const confState: ConfState = {
    field: { w: DEFAULT_FIELD_W, h: DEFAULT_FIELD_H, step: DEFAULT_STEP },
    pxPerM: DEFAULT_PX_PER_M,
    tool: 'select',

    cameras: [],
    zones: [],
    images: [],
    gabarits: [],
    machineHeight: 0,
    matSize: DEFAULT_MAT,

    selected: null,
    measureRef: null,
    dragging: null,
    resize: null,

    view: { ox: 0, oy: 0, scale: 1 },

    draft: null,
    placing: null,

    showCrosshair: false,
    cursor: null,

    presetId: '',
    presetName: '',
};

// Округление до миллиметра. Деление на step и обратное умножение копят хвосты
// двоичной дроби, и String(value) в NumberField показал бы их пользователю.
export function q(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 1000) / 1000;
}

// Метры для показа: три знака, как квант хранения
export function fmtM(v: number): string {
    return v.toFixed(3);
}

export const COLORS: Record<'camera' | 'zone', string[]> = {
    camera: ['#378ADD', '#D85A30', '#1D9E75', '#D4537E', '#BA7517', '#534AB7'],
    zone: ['#85B7EB', '#F0997B', '#5DCAA5', '#ED93B1', '#FAC775', '#AFA9EC'],
};

export const HANDLE_SIZE = 5;

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

// Внешний стор для useSyncExternalStore. version растёт только при
// emitConfChange; canvas на него не подписан и перерисовывается через confDraw.
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

// Точки фиксации: создание и удаление объекта, смена выделения, переименование,
// завершение drag/resize/rotate, правка параметров поля. Во время drag'а не
// вызывается.
export function emitConfChange(): void {
    version++;
    listeners.forEach(fn => fn());
}

// Подписывает компонент на точки фиксации confState
export function useConfStore(): number {
    return useSyncExternalStore(subscribe, getSnapshot);
}

export function getList(type: ConfItemType): Array<ConfCamera | ConfZone | ConfImage | ConfGabarit> {
    if (type === 'camera') return confState.cameras;
    if (type === 'zone') return confState.zones;
    if (type === 'gabarit') return confState.gabarits;
    return confState.images;
}
