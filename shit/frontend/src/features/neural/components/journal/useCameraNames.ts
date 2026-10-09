import { useEffect, useMemo, useState } from 'react';
import { useSystem } from '../../../../app/SystemContext';
import { neuralApi } from '../../api/client';

export interface CameraEntry {
  id: string;
  name: string;
  deviceId: string;
  /** есть поток с назначением neural — только такие камеры попадают в фильтр */
  neural: boolean;
}

// В записи журнала только id камеры и устройства; имена берём из списка камер бэкенда и реестра устройств
export function useCameraNames() {
  const { devices } = useSystem();
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
          deviceId: info.device_id ?? '',
          neural: Object.values(info.streams ?? {}).some((st) => st.purposes?.includes('neural')),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setCameras(list);
      })
      .catch(() => {
        /* бэкенд недоступен — останутся сырые id */
      });
    return () => {
      alive = false;
    };
  }, []);

  return useMemo(() => {
    const names: Record<string, string> = {};
    for (const c of cameras) names[c.id] = c.name;
    const deviceNames: Record<string, string> = {};
    for (const d of devices) deviceNames[d.id] = d.name || d.id;
    return {
      // имя резолвим по всем камерам: в журнале есть записи камер, у которых назначение сняли
      cameraName: (cameraId: string) => names[cameraId] || cameraId,
      deviceName: (deviceId: string) => deviceNames[deviceId] || deviceId,
      cameras: cameras.filter((c) => c.neural),
      devices,
    };
  }, [cameras, devices]);
}
