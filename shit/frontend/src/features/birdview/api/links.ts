/**
 * Сопоставление камер birdview и конфигураций калибровки: /calibration/links
 * на устройстве модуля birdview. По нему плеер показывает значок коррекции,
 * а камера на устройстве поднимает поток коррекции.
 */

import { modulePath } from '../../../services/devices';

/** Конфигурация калибровки из calibration_settings.json. */
export interface CalibrationConfigInfo {
    config_key: string;
    id: string;
    name?: string;
    width: number;
    height: number;
}

/** Связь камеры с калибровкой и частота коррекционного потока. */
export interface CalibrationLink {
    config: string;
    fps: number;
}

/** camera_id → связь. */
export type CalibrationLinks = Record<string, CalibrationLink>;

export const DEFAULT_CORRECTION_FPS = 15;

export interface CalibrationLinksData {
    links: CalibrationLinks;
    configs: CalibrationConfigInfo[];
}

export async function fetchCalibrationLinks(): Promise<CalibrationLinksData> {
    const res = await fetch(modulePath('birdview', '/calibration/links'), {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`Не удалось получить сопоставления: ${res.status}`);
    }
    const json = await res.json();
    const data = json.data ?? json;
    const configs = (Array.isArray(data.configs) ? data.configs : [])
        .map((c: any): CalibrationConfigInfo => ({
            config_key: String(c.config_key ?? ''),
            id: String(c.id ?? ''),
            name: typeof c.name === 'string' && c.name ? c.name : undefined,
            width: Number(c.width) || 0,
            height: Number(c.height) || 0,
        }))
        .filter((c: CalibrationConfigInfo) => c.config_key);

    // Легаси-формат — строка config_key без fps
    const links: CalibrationLinks = {};
    for (const [cameraId, value] of Object.entries<any>(data.links ?? {})) {
        if (typeof value === 'string' && value) {
            links[cameraId] = { config: value, fps: DEFAULT_CORRECTION_FPS };
        } else if (value && typeof value === 'object' && typeof value.config === 'string' && value.config) {
            links[cameraId] = {
                config: value.config,
                fps: Number(value.fps) || DEFAULT_CORRECTION_FPS,
            };
        }
    }

    return { links, configs };
}

export async function saveCalibrationLinks(links: CalibrationLinks): Promise<void> {
    const res = await fetch(modulePath('birdview', '/calibration/links'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ links }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let reason = text;
        try {
            reason = JSON.parse(text).error ?? text;
        } catch {
            // Ответ не json — берём тело целиком
        }
        throw new Error(reason || `Не удалось сохранить: ${res.status}`);
    }
}
