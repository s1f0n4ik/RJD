/**
 * Протокол основного WebSocket калибратора (/signaling/cal-client/server).
 *
 * Формат запроса: { type, client_id, camera?, meta, ret }.
 * Корреляции запрос-ответ в протоколе нет — ответы разбираются по type,
 * а внутри calibration_configuration и projection_configuration ещё и по
 * meta.method. Именно поэтому здесь подписка на тип, а не promise-RPC.
 */

/** Типы сообщений, которые калибратор присылает клиенту. */
export type WsIncomingType =
    | 'connection'
    | 'add_image'
    | 'delete_image'
    | 'get_image'
    | 'chessboard'
    | 'status'
    | 'get_pattern'
    | 'calibration_start'
    | 'calibration_progress'
    | 'calibration_post_process'
    | 'calibration_compute'
    | 'calibration_result'
    | 'undistort_compute'
    | 'view_undistort'
    | 'panorama_toggle'
    | 'calibration_configuration'
    | 'projection_configuration';

export interface WsMessage {
    type: string;
    /** Сервер шлёт false при ошибке; в запросах используется строка 'none'. */
    ret?: boolean | string;
    client_id?: string;
    camera?: string;
    meta?: Record<string, any>;
    /** JPEG-байты бинарного кадра. Есть только у get_image. */
    imageBytes?: Uint8Array;
}

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

export type LogLevel = 'info' | 'ok' | 'warn' | 'err';

/** Ключи слайдеров коррекции — они же имена полей в meta. */
export type SliderKey =
    | 'alpha'
    | 'zoom'
    | 'shift_x'
    | 'shift_y'
    | 'k1'
    | 'k2'
    | 'k3'
    | 'k4'
    | 'radius';

/** Ключи, которые уходят в undistort_compute как коэффициенты дисторсии. */
export const K_KEYS: SliderKey[] = ['k1', 'k2', 'k3', 'k4'];

/** Камера, пригодная для калибровки, из /api/camera. */
export interface CalibrationCamera {
    id: string;
    displayName: string;
    width: number;
    height: number;
    fps: number;
}
