/** Типы страницы «Система 360». */

/** Экраны навбара. Порядок соответствует data-step в старой вёрстке. */
export type ScreenId = 'calibration' | 'projection' | 'linker' | 'configurator';

/** Общий тип для всего, что расставляется на поле конфигуратора. */
// x, y, w, h — метры поля; в пиксели переводит только conf-export
export interface ConfItem {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface ConfCamera extends ConfItem {
    /** Ключ, под которым камера попадает в экспортируемый JSON. */
    key: string;
    name: string;
    color: string;
}

// Разметка первична и к камерам не привязана: камера захватывает мат, когда
// он целиком лежит в её прямоугольнике. Мат — всегда осевой квадрат; его
// «поворот» (направление стрелки и порядок углов) считается на лету per камера
export interface ConfZone extends ConfItem {
    key: string;
    name: string;
    color: string;
}

export interface ConfImage extends ConfItem {
    name: string;
    /** Исходный файл — уходит в FormData при сохранении конфигурации. */
    file: File;
    img: HTMLImageElement;
}

/** Габарит машины: один прямоугольник на конфигурацию, без картинки. */
export type ConfGabarit = ConfItem;

export type ConfItemType = 'camera' | 'zone' | 'image' | 'gabarit';

export type ConfTool = 'select' | 'camera' | 'zone' | 'gabarit';

export interface ConfSelection {
    type: ConfItemType;
    id: string;
}

/** Камера из /api/camera, пригодная для birdview (type === 3). */
export interface BirdviewCamera {
    id: string;
    displayName: string;
    width: number;
    height: number;
    fps: number;
}
