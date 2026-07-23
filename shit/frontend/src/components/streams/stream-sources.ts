import type { CPPCamera, StreamProducer, StreamSource, VirtualStream } from '../../types';
import { CAMERA_STATUS } from '../../utils/constants';

// Система, собравшая поток
export const PRODUCER_NAME: Record<StreamProducer, string> = {
    birdview: 'Система 360',
    neural: 'Техническое зрение',
};

export const PRODUCER_PAGE: Record<StreamProducer, string> = {
    birdview: '/app/birdview',
    neural: '/app/neural',
};

// Приведение камер и виртуальных потоков к общему минимуму

export function cameraToSource(camera: CPPCamera): StreamSource {
    return {
        id: camera.id,
        name: camera.display_name || camera.id,
        active: camera.streams?.main?.status === CAMERA_STATUS.RUNNING,
    };
}

// Вторая строка списка: имя одной камеры или количество, если их несколько
function describe(stream: VirtualStream, nameOf: (id: string) => string): string {
    if (stream.cameras.length === 0) return 'камеры не назначены';
    if (stream.cameras.length === 1) return nameOf(stream.cameras[0]);
    return `${stream.cameras.length} ${pluralCameras(stream.cameras.length)}`;
}

function pluralCameras(n: number): string {
    const tens = n % 100;
    if (tens >= 11 && tens <= 14) return 'камер';
    switch (n % 10) {
        case 1: return 'камера';
        case 2:
        case 3:
        case 4: return 'камеры';
        default: return 'камер';
    }
}

export function streamToSource(
    stream: VirtualStream,
    nameOf: (id: string) => string,
): StreamSource {
    return {
        id: stream.id,
        name: stream.name || stream.id,
        active: stream.running,
        detail: describe(stream, nameOf),
    };
}

// Имя камеры по id вместо служебного идентификатора
export function makeCameraNameResolver(cameras: CPPCamera[]) {
    return (id: string): string => cameras.find(c => c.id === id)?.display_name || id;
}

// Тип для PlayerFactory: обычный плеер, рамки в нейронный поток уже врисованы
export const SOURCE_PLAYER_TYPE = 1;
