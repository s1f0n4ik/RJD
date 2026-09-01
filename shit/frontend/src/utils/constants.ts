// utils/constants.ts

/**
 * Строит URL для WebSocket с тем же хостом и портом, что и текущая страница.
 * Сам выбирает ws/wss в зависимости от протокола.
 *
 * Использование:
 *   wsUrl('/ws')                       → ws://host/ws
 *   wsUrl('/signaling/client/cam_1')   → ws://host/signaling/client/cam_1
 */
export const wsUrl = (path: string): string => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${proto}//${window.location.host}${cleanPath}`;
};

// ── Доменные константы ──

export const ENDPOINT_MAP: Record<string, string> = {
    'id_1': '/neural_1',
    'id_2': '/neural_2',
    'id_3': '/neural_3',
};

export const CAMERA_TYPE_URLS = {
    HIKVISION: 1,
    DAHUA: 2,
    ACE: 3,
    BEWARD: 4,
} as const;

export const CAMERA_STATUS = {
    NO_PIPELINE: 0,
    READY: 1,
    STOPPED: 2,
    RUNNING: 3,
} as const;

export const TRANSLATION_PATH_PREFIX = '/translation';