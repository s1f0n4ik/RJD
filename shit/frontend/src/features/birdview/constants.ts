/**
 * Константы, общие для нескольких экранов «Системы 360».
 *
 * PROJ_POSITION_LABELS в no-react жил в projection-consts.js и импортировался
 * и линкером, и проекцией — здесь он на том же положении общего словаря.
 */

/** Человекочитаемые названия позиций камер вокруг состава. */
export const PROJ_POSITION_LABELS: Record<string, string> = {
    front: 'Передняя',
    right: 'Правая',
    right_front: 'Спереди правая',
    right_back: 'Сзади правая',
    back: 'Задняя',
    left: 'Левая',
    left_back: 'Сзади левая',
    left_front: 'Спереди левая',
};

import { birdviewSignalingUrl } from '../../services/devices';

/** Строит ws:// или wss:// адрес от текущего хоста. */
export function wsUrl(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    // Сигналинг фичи живёт на устройстве модуля birdview
    if (cleanPath.startsWith('/signaling/')) {
        return birdviewSignalingUrl(cleanPath.slice('/signaling'.length));
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${cleanPath}`;
}
