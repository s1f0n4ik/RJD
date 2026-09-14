import { useEffect, useMemo, useState } from 'react';
import { neuralApi } from '../../api/client';

export interface CameraEntry {
  id: string;
  name: string;
  /** есть поток с назначением neural — только такие камеры попадают в фильтр */
  neural: boolean;
}

// В записи журнала лежит только camera_id — журнал camera-агностичен, как и с
// классами. Отображаемое имя знает media-center, поэтому тянем его список камер
// один раз и резолвим на фронте. Камеры нет в списке — показываем сырой id.
export function useCameraNames() {
  const [cameras, setCameras] = useState<CameraEntry[]>([]);

  useEffect(() => {
    let alive = true;
    neuralApi
      .listCameras()
      .then((res) => {
        if (!alive || !res.cameras) return;
        const list = Object.entries(res.cameras).map(([id, info]) => ({
          id,
          name: info.display_name || id,
          neural: Object.values(info.streams ?? {}).some((st) => st.purposes?.includes('neural')),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setCameras(list);
      })
      .catch(() => {
        /* media-center недоступен — останутся сырые id */
      });
    return () => {
      alive = false;
    };
  }, []);

  return useMemo(() => {
    const names: Record<string, string> = {};
    for (const c of cameras) names[c.id] = c.name;
    return {
      // имя резолвим по всем камерам: в журнале есть записи камер, у которых назначение сняли
      cameraName: (cameraId: string) => names[cameraId] || cameraId,
      cameras: cameras.filter((c) => c.neural),
    };
  }, [cameras]);
}
