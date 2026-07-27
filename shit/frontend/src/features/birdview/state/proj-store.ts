import { useSyncExternalStore } from 'react';

/**
 * Состояние экрана проекции. Порт projection-consts.js.
 *
 * Как и в конфигураторе, это мутируемый объект вне React: точки таскают
 * мышью, и гонять каждое движение через рендер нельзя. Компоненты читают
 * его через useProjStore и обновляются только в точках фиксации —
 * добавление и удаление точки, смена камеры, ответ сервера.
 */

export interface ProjPoint {
    /** Нормализованные координаты 0..1 относительно кадра. */
    x: number;
    y: number;
    id: number;
}

export interface ProjPresetCamera {
    key: string;
    name?: string;
    max_points?: number;
    points_count?: number;
    /** Точки, сохранённые в пресете на сервере. Нормированные 0..1. */
    src_points?: Array<{ x: number; y: number }>;
    /** Привязанная физическая камера из пресета: чей кадр размечали. */
    camera_id?: string;
    /** Ключ конфигурации коррекции, с которой размечали. */
    calibration?: string;
}

export interface ProjPresetSummary {
    config_key: string;
    name?: string;
}

export interface ProjActivePreset {
    config_key: string;
    name?: string;
    cameras: ProjPresetCamera[];
}

export interface ProjState {
    presets: ProjPresetSummary[];
    activePreset: ProjActivePreset | null;

    activeCam: string | null;

    /** Точки, уже применённые для каждой камеры. */
    pointsByCam: Record<string, ProjPoint[]>;
    /** Точки активной камеры — рабочий набор. */
    points: ProjPoint[];
    /** Точки, пришедшие в пресете с сервера. Пока оператор не подтвердил загрузку — не в работе. */
    savedPointsByCam: Record<string, ProjPoint[]>;

    /** Камеры, для которых warp применён. */
    doneSet: Set<string>;
    maxPointsByCam: Record<string, number>;
    /** Привязка места к камере: из пресета при set_preset, из ответа apply_warp. */
    camId: Record<string, string>;
    /** Ключ конфигурации коррекции места — источники те же. */
    calibKey: Record<string, string>;

    applied: boolean;

    /** Зум и панорамирование области warp. */
    view: { scale: number; ox: number; oy: number };
}

export const MIN_SCALE = 1.0;
export const MAX_SCALE = 12.0;
/** Порог, ниже которого движение считается кликом, а не перетаскиванием. */
export const DRAG_THRESHOLD = 0.005;

export const projState: ProjState = {
    presets: [],
    activePreset: null,

    activeCam: null,

    pointsByCam: {},
    points: [],
    savedPointsByCam: {},

    doneSet: new Set(),
    maxPointsByCam: {},
    camId: {},
    calibKey: {},

    applied: false,

    view: { scale: 1, ox: 0, oy: 0 },
};

export function currentMaxPoints(): number {
    if (!projState.activeCam) return 0;
    return projState.maxPointsByCam[projState.activeCam] ?? 0;
}

/** Хоть где-то есть размеченные точки — смена пресета их потеряет. */
export function hasAnyPoints(): boolean {
    if (projState.points.length > 0) return true;
    return Object.values(projState.pointsByCam).some(pts => pts.length > 0);
}

/** Камеры, для которых сервер прислал сохранённую разметку. */
export function camerasWithSavedPoints(): string[] {
    return Object.keys(projState.savedPointsByCam).filter(
        key => projState.savedPointsByCam[key].length > 0,
    );
}

/**
 * Перенос сохранённой разметки в рабочий набор.
 *
 * doneSet не трогаем: точки есть, но карт проекции на сервере нет, пока не
 * прошёл apply_warp. Иначе разблокировался бы расчёт LUT без единой карты.
 */
export function restoreSavedPoints(): void {
    for (const [key, pts] of Object.entries(projState.savedPointsByCam)) {
        if (pts.length > 0) projState.pointsByCam[key] = pts.map(p => ({ ...p }));
    }
    if (projState.activeCam) {
        projState.points = (projState.pointsByCam[projState.activeCam] ?? []).map(p => ({ ...p }));
    }
    projState.applied = false;
}

/** Все камеры пресета получили warp — можно считать LUT. */
export function allCamerasDone(): boolean {
    const cams = projState.activePreset?.cameras ?? [];
    return cams.length > 0 && cams.every(c => projState.doneSet.has(c.key));
}

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

/** Точка фиксации: UI обязан увидеть изменение. Во время drag не вызывается. */
export function emitProjChange(): void {
    version++;
    listeners.forEach(fn => fn());
}

export function useProjStore(): number {
    return useSyncExternalStore(subscribe, getSnapshot);
}

/** Сброс рабочего набора при смене пресета. */
export function resetPreset(preset: ProjActivePreset): void {
    projState.activePreset = preset;
    projState.activeCam = null;
    projState.pointsByCam = {};
    projState.points = [];
    projState.savedPointsByCam = {};
    projState.doneSet = new Set();
    projState.maxPointsByCam = {};
    projState.camId = {};
    projState.calibKey = {};
    projState.applied = false;

    // doneSet заполняется только фактическими apply_warp в текущей сессии.
    // Сохранённые в пресете точки говорят лишь о том, что есть что восстановить:
    // карт проекции на сервере после смены пресета нет, и расчёт LUT без них падает.
    preset.cameras.forEach(cam => {
        projState.maxPointsByCam[cam.key] = cam.max_points ?? 0;
        projState.savedPointsByCam[cam.key] = (cam.src_points ?? []).map((p, idx) => ({
            x: p.x,
            y: p.y,
            id: Date.now() + idx,
        }));
        // Привязка из пресета видна сразу, до всякого warp в этой сессии
        if (cam.camera_id) projState.camId[cam.key] = cam.camera_id;
        if (cam.calibration) projState.calibKey[cam.key] = cam.calibration;
    });
}
