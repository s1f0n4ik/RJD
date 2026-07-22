import { useEffect, useMemo, useState } from 'react';
import { neuralApi } from '../../api/client';

// В записи журнала лежит только camera_id — журнал camera-агностичен, как и с
// классами. Отображаемое имя знает media-center, поэтому тянем его список камер
// один раз и резолвим на фронте. Камеры нет в списке — показываем сырой id.
export function useCameraNames() {
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    neuralApi
      .listCameras()
      .then((res) => {
        if (!alive || !res.cameras) return;
        const map: Record<string, string> = {};
        for (const [id, info] of Object.entries(res.cameras)) {
          if (info.display_name) map[id] = info.display_name;
        }
        setNames(map);
      })
      .catch(() => {
        /* media-center недоступен — останутся сырые id */
      });
    return () => {
      alive = false;
    };
  }, []);

  return useMemo(() => (cameraId: string) => names[cameraId] || cameraId, [names]);
}
