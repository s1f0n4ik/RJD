/**
 * Источники стены: камеры и собранные потоки.
 *
 * Типа камеры в модели больше нет, поэтому возможности ячейки выводятся из
 * назначений её потоков: есть поток neural — доступен слой обнаружений, есть
 * birdview — тумблер коррекции (плюс проверка сопоставления калибровки уже в
 * самой ячейке).
 */

import type { CPPCamera, StreamProducer, VirtualStream } from '../../types';
import { CAMERA_STATUS } from '../../utils/constants';
import { PRODUCER_NAME } from '../../components/streams/stream-sources';

export interface ViewStream {
    /** Ключ потока: stream_1, stream_2, … */
    key: string;
    label: string;
    running: boolean;
}

export interface WallSource {
    id: string;
    name: string;
    kind: 'camera' | 'virtual';
    /** Хотя бы один поток работает */
    active: boolean;
    /** Устройство не ответило, данные из кэша мастера */
    offline: boolean;
    deviceId?: string;
    /** Вторая строка списка: состав виртуального потока или адрес камеры */
    detail?: string;
    producer?: StreamProducer;
    /** Смотрибельные потоки камеры */
    viewStreams: ViewStream[];
    hasNeural: boolean;
    hasBirdview: boolean;
}

// Разрешение — единственное, что отличает потоки для глаза
function streamLabel(stream: CPPCamera['streams'][string]): string {
    if (stream.width && stream.height) return `${stream.width}×${stream.height}`;
    return stream.substream ? `канал ${stream.channel} · ${stream.substream}` : `канал ${stream.channel}`;
}

export function cameraToWallSource(camera: CPPCamera): WallSource {
    const entries = Object.entries(camera.streams ?? {});

    const viewStreams = entries
        .filter(([, stream]) => stream.purposes?.includes('view'))
        .map(([key, stream]) => ({
            key,
            label: streamLabel(stream),
            running: stream.status === CAMERA_STATUS.RUNNING,
        }));

    return {
        id: camera.id,
        name: camera.display_name || camera.id,
        kind: 'camera',
        // Кэшированный статус offline-устройства устарел — «в работе» не показываем
        active: !camera.offline && entries.some(([, s]) => s.status === CAMERA_STATUS.RUNNING),
        offline: Boolean(camera.offline),
        deviceId: camera.device_id,
        detail: camera.ip_adress,
        viewStreams,
        hasNeural: entries.some(([, s]) => s.purposes?.includes('neural')),
        hasBirdview: entries.some(([, s]) => s.purposes?.includes('birdview')),
    };
}

export function virtualToWallSource(stream: VirtualStream, nameOf: (id: string) => string): WallSource {
    const cameras = stream.cameras.length === 1
        ? nameOf(stream.cameras[0])
        : `${stream.cameras.length} камер`;

    return {
        id: stream.id,
        name: stream.name || stream.id,
        kind: 'virtual',
        active: !stream.offline && stream.running,
        offline: Boolean(stream.offline),
        deviceId: stream.device_id,
        detail: stream.cameras.length ? `${PRODUCER_NAME[stream.producer]} · ${cameras}` : PRODUCER_NAME[stream.producer],
        producer: stream.producer,
        viewStreams: [],
        hasNeural: false,
        hasBirdview: false,
    };
}

/**
 * Какой поток показывать: сохранённый, если он ещё смотрибелен, иначе первый.
 * Подмену возвращаем наружу — ячейка обязана о ней сказать, человек выбирал
 * поток осознанно (ради полосы или ради канала).
 */
export function resolveStream(
    source: WallSource | undefined,
    saved: string | undefined,
): { key: string | undefined; fallback: boolean } {
    if (!source || source.kind !== 'camera') return { key: undefined, fallback: false };
    if (!saved) return { key: source.viewStreams[0]?.key, fallback: false };
    if (source.viewStreams.some(s => s.key === saved)) return { key: saved, fallback: false };
    return { key: source.viewStreams[0]?.key, fallback: true };
}
