import type { CalibrationCamera } from './ws-types';

// Камера годится для 360, если у неё есть поток с назначением birdview; разрешение и fps берутся из него
export function birdviewStream(cam: any): any | null {
    return Object.values<any>(cam?.streams ?? {}).find(s => Array.isArray(s.purposes) && s.purposes.includes('birdview')) ?? null;
}

/** Камеры для калибровки: только с потоком назначения birdview. */
export async function fetchCalibrationCameras(): Promise<CalibrationCamera[]> {
    const res = await fetch('/api/cameras');
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? String(json.error));

    const cameras = json?.data?.cameras ?? json?.cameras ?? {};
    const items: CalibrationCamera[] = [];

    for (const [id, cam] of Object.entries<any>(cameras)) {
        const sub = birdviewStream(cam);
        if (!sub) continue;
        items.push({
            id,
            displayName: cam.display_name ?? id,
            width: sub.width,
            height: sub.height,
            fps: sub.fps,
        });
    }

    return items;
}

/** Отображаемые имена камер по id — нужны в модалке конфигураций. */
export async function fetchCameraNames(): Promise<Record<string, string>> {
    try {
        const res = await fetch('/api/cameras');
        const json = await res.json();
        const cameras = json?.data?.cameras ?? json?.cameras ?? {};
        const map: Record<string, string> = {};
        for (const [id, cam] of Object.entries<any>(cameras)) {
            map[id] = cam.display_name ?? id;
        }
        return map;
    } catch {
        return {};
    }
}
