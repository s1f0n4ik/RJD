/**
 * Запросы экрана проекции. Порт proj-server.js.
 *
 * Всё идёт одним типом сообщения projection_configuration, метод лежит в
 * meta.method — так же, как calibration_configuration у калибровки.
 */

export const PROJ_TYPE = 'projection_configuration';

export const PROJ_METHOD = {
    GET_LIST: 'get_list',
    SET_PRESET: 'set_preset',
    APPLY_WARP: 'apply_warp',
    SAVE_LUT: 'save_lut',
} as const;

export type ProjMethod = (typeof PROJ_METHOD)[keyof typeof PROJ_METHOD];

/** Точка, как её ждёт сервер: нормализованная, 8 знаков после запятой. */
export interface WarpPoint {
    x: number;
    y: number;
}

export function toWarpPoints(points: Array<{ x: number; y: number }>): WarpPoint[] {
    return points.map(p => ({ x: +p.x.toFixed(8), y: +p.y.toFixed(8) }));
}
