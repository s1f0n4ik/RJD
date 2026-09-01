/**
 * Камеры, к которым применима коррекция дисторсии.
 *
 * Коррекция возможна только у камеры с настроенным сопоставлением калибровки
 * (вкладка 360 → Сопоставление). Спрашиваем один раз на экран, а не в каждой
 * ячейке: ответ общий для всех.
 */

import { useEffect, useState } from 'react';
import { fetchCalibrationLinks } from '../../features/birdview/api/links';

export function useCorrectionLinks(): Record<string, boolean> {
    const [links, setLinks] = useState<Record<string, boolean>>({});

    useEffect(() => {
        let alive = true;

        fetchCalibrationLinks()
            .then(data => {
                if (!alive) return;
                const map: Record<string, boolean> = {};
                Object.entries(data.links ?? {}).forEach(([cameraId, link]) => {
                    map[cameraId] = Boolean(link);
                });
                setLinks(map);
            })
            // Модуль 360 может быть не поднят — тогда коррекции просто нет
            .catch(() => { if (alive) setLinks({}); });

        return () => { alive = false; };
    }, []);

    return links;
}
