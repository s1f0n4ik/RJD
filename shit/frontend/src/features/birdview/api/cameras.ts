import type { CalibrationCamera } from './ws-types';

/**
 * Список камер для калибровки. Порт _fetchList из camera.js.
 *
 * Берём только type === 3 (камеры кругового обзора) и внутри каждой —
 * поток type === 1, из которого приходят разрешение и fps.
 */
export async function fetchCalibrationCameras(): Promise<CalibrationCamera[]> {
    const res = await fetch('/api/cameras');
    const json = await res.json();
    if (json.error) throw new Error(json.error);

    const cameras = json?.data?.cameras ?? {};
    const items: CalibrationCamera[] = [];

    for (const [id, cam] of Object.entries<any>(cameras)) {
        if (cam.type !== 3) continue;
        const sub = Object.values<any>(cam.streams ?? {}).find(s => s.type === 1);
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
        const cameras = (await res.json())?.data?.cameras ?? {};
        const map: Record<string, string> = {};
        for (const [id, cam] of Object.entries<any>(cameras)) {
            map[id] = cam.display_name ?? id;
        }
        return map;
    } catch {
        return {};
    }
}
