import { useEffect, useMemo, useState } from 'react';
import { neuralApi } from '../../api/client';

// Журнал хранит только id класса (cid) и config_id. Смысл (имя, цвет, суперкласс)
// живёт в конфигурации — этот хук загружает классы/суперклассы всех конфигураций
// и резолвит пару config_id + cid в человекочитаемое представление.

export interface ClassMeaning {
  name: string;
  color: string;
  superKey: string;
  superName: string;
  superColor: string;
}

export interface ClassOption {
  cid: number;
  name: string;
  color: string;
  superKey: string;
  superName: string;
  superColor: string;
}

const UNKNOWN: ClassMeaning = {
  name: '',
  color: '#667089',
  superKey: '',
  superName: '',
  superColor: '#667089',
};

export function useClassResolver() {
  // config_id -> (cid -> meaning)
  const [byConfig, setByConfig] = useState<Record<string, Map<number, ClassMeaning>>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { configurations } = await neuralApi.listConfigurations();
        const entries = await Promise.all(
          configurations.map(async (c) => {
            const [cls, sup] = await Promise.all([
              neuralApi.getClasses(c.id).catch(() => ({ classes: [] as any[] })),
              neuralApi.getSuperclasses(c.id).catch(() => ({ superclasses: [] as any[] })),
            ]);
            const supMap = new Map<string, { name: string; color: string }>();
            for (const s of sup.superclasses) supMap.set(s.key, { name: s.name, color: s.color });

            const map = new Map<number, ClassMeaning>();
            for (const k of cls.classes) {
              // cid матчим и по id (ключ записи классов), и по server_id — какой
              // из них численно совпал с cid из журнала, тот и берём.
              const cid = Number.isFinite(Number(k.id)) ? Number(k.id) : Number(k.server_id);
              const s = supMap.get(k.superclass);
              map.set(cid, {
                name: k.name,
                color: k.color,
                superKey: k.superclass,
                superName: s?.name ?? k.superclass,
                superColor: s?.color ?? k.color,
              });
            }
            return [c.id, map] as const;
          }),
        );
        if (alive) setByConfig(Object.fromEntries(entries));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const resolve = useMemo(
    () =>
      (configId: string | null, cid: number): ClassMeaning => {
        if (!configId) return UNKNOWN;
        return byConfig[configId]?.get(cid) ?? UNKNOWN;
      },
    [byConfig],
  );

  // Плоский список классов для фильтра (дедуп по cid+имя), сгруппированный по
  // суперклассу вызывающим кодом.
  const classOptions = useMemo<ClassOption[]>(() => {
    const seen = new Set<string>();
    const out: ClassOption[] = [];
    for (const map of Object.values(byConfig)) {
      for (const [cid, m] of map) {
        const key = `${cid}:${m.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ cid, ...m });
      }
    }
    out.sort((a, b) => a.superName.localeCompare(b.superName) || a.name.localeCompare(b.name));
    return out;
  }, [byConfig]);

  return { resolve, classOptions, loading };
}
