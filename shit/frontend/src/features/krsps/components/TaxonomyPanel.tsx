import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../app/Icons';
import { Select } from '../../../app/Select';
import type {
  GwTaxonomy,
  GwTaxonomyCamera,
  GwTaxonomyConfig,
  GwTaxonomyDictItem,
  GwTaxonomyPatch,
  GwTaxonomyRule,
} from '../types';
import { configMeta, listAllConfigurations } from '../../neural/api/client';
import type { ConfigSummary } from '../../neural/api/types';
import { useCameraNames } from '../../neural/components/journal/useCameraNames';

interface Props {
  taxonomy: GwTaxonomy | null;
  busy: boolean;
  onSave: (patch: GwTaxonomyPatch) => void;
}

// Таблицы классов и суперклассов — свои у каждой конфигурации нейросети, правки
// правил сохраняются кнопкой таблицы, добавление и удаление таблицы — сразу.
// Номера камер вне конфигураций, любое изменение сохраняется сразу.
// Тип обнаружения по умолчанию — id класса + 1; класс вне 0..7 подсвечивается флагом.
// Опасность задаёт суперкласс, класс наследует её и может переопределить (0 — не задано).

const INHERIT = 0;

type RuleKind = 'classes' | 'superclasses';

// Метаданные конфигурации из media-center: id класса, цвет и связь класс→суперкласс
interface SuperMeta {
  key: string;
  name: string;
  color: string;
}
interface ClassMeta {
  key: string;
  cid: number;
  name: string;
  superKey: string;
  color: string;
}
interface ConfigMeta {
  supers: SuperMeta[];
  classes: ClassMeta[];
}

const NEUTRAL = '#94a1ab';

const rgba = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(148,161,171,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// Подкомпоненты уровня модуля: объявленные внутри рендера пересоздавали бы поддерево
// «Не задано» показывается приглушённой подсказкой, а в списке остаётся пунктом
const Sel: React.FC<{
  value: number;
  items: GwTaxonomyDictItem[];
  placeholder: string;
  onChange: (v: number) => void;
}> = ({ value, items, placeholder, onChange }) => (
  <Select
    value={value === INHERIT ? '' : String(value)}
    placeholder={placeholder}
    options={[
      { value: String(INHERIT), label: placeholder },
      ...items.map((i) => ({ value: String(i.id), label: `${i.id} · ${i.title}` })),
    ]}
    onChange={(v) => onChange(Number(v))}
  />
);

const findRule = (rules: GwTaxonomyRule[], key: string): GwTaxonomyRule | undefined =>
  rules.find((r) => r.key.toLowerCase() === key.toLowerCase());

// Сохранённые правила совмещаем со структурой модели
const reconcile = (cfg: GwTaxonomyConfig, m: ConfigMeta, typeIds: Set<number>): GwTaxonomyConfig => {
  const superclasses = m.supers.map((s) => {
    const ex = findRule(cfg.superclasses, s.key);
    return { key: s.key, title: s.name || s.key, type: INHERIT, danger: ex?.danger ?? INHERIT };
  });
  const classes = m.classes.map((c) => {
    const ex = findRule(cfg.classes, c.key);
    const defType = typeIds.has(c.cid + 1) ? c.cid + 1 : INHERIT;
    return { key: c.key, title: c.name || c.key, type: ex?.type ?? defType, danger: ex?.danger ?? INHERIT };
  });
  return { ...cfg, superclasses, classes };
};

const buildMeta = (
  classes: { id: string; name: string; superclass: string }[],
  supers: { key: string; name: string; color: string }[],
): ConfigMeta => {
  const sm: SuperMeta[] = supers.map((s) => ({ key: s.key, name: s.name || s.key, color: s.color || NEUTRAL }));
  const colorOf = (k: string) => sm.find((s) => s.key === k)?.color ?? NEUTRAL;
  const cm: ClassMeta[] = classes.map((c) => ({
    key: c.name,
    cid: Number(c.id),
    name: c.name,
    superKey: c.superclass || '',
    color: colorOf(c.superclass || ''),
  }));
  return { supers: sm, classes: cm };
};

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

const TaxonomyPanel: React.FC<Props> = ({ taxonomy, busy, onSave }) => {
  const [configs, setConfigs] = useState<GwTaxonomyConfig[]>([]);
  const [meta, setMeta] = useState<Record<string, ConfigMeta>>({});
  const [cameras, setCameras] = useState<GwTaxonomyCamera[]>([]);
  const [error, setError] = useState('');

  // Списки из media-center: конфигурации и камеры выбираются из готового
  const [known, setKnown] = useState<ConfigSummary[]>([]);
  const { cameras: knownCameras } = useCameraNames();

  const fetchedMeta = useRef<Set<string>>(new Set());

  const types = useMemo<GwTaxonomyDictItem[]>(() => taxonomy?.types ?? [], [taxonomy]);
  const dangers = useMemo<GwTaxonomyDictItem[]>(() => taxonomy?.dangers ?? [], [taxonomy]);
  const typeIds = useMemo(() => new Set(types.map((t) => t.id)), [types]);
  const defaults = taxonomy?.defaults ?? { type: 0, danger: 0 };
  const dangerTitle = (id: number) => dangers.find((d) => d.id === id)?.title ?? `класс ${id}`;

  useEffect(() => {
    if (!taxonomy) return;
    setConfigs(
      (taxonomy.configs ?? []).map((c) => ({
        ...c,
        classes: c.classes ?? [],
        superclasses: c.superclasses ?? [],
      })),
    );
    setCameras(taxonomy.cameras ?? []);
  }, [taxonomy]);

  useEffect(() => {
    let stop = false;
    listAllConfigurations()
      .then((list) => {
        if (!stop) setKnown(list);
      })
      .catch(() => {
        /* media-center недоступен — таблицу можно только смотреть */
      });
    return () => {
      stop = true;
    };
  }, []);

  // Метаданные подтягиваем на каждый config_id из шлюза; ключ — только список id
  const configIdsKey = configs.map((c) => c.id).join('|');
  useEffect(() => {
    const ids = configIdsKey ? configIdsKey.split('|') : [];
    ids.forEach((id) => {
      if (!id || fetchedMeta.current.has(id)) return;
      fetchedMeta.current.add(id);
      configMeta(id)
        .then(([cls, scls]) => {
          const m = buildMeta(cls.classes ?? [], scls.superclasses ?? []);
          setMeta((prev) => ({ ...prev, [id]: m }));
          setConfigs((prev) => prev.map((c) => (c.id === id ? reconcile(c, m, typeIds) : c)));
        })
        .catch(() => {
          fetchedMeta.current.delete(id);
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configIdsKey]);

  // Новая таблица: структура модели, умолчания и сразу сохранение
  const addConfig = useCallback(
    async (id: string) => {
      if (!id || configs.some((c) => c.id === id)) return;
      const title = known.find((k) => k.id === id)?.name ?? id;
      try {
        const [cls, scls] = await configMeta(id);
        const m = buildMeta(cls.classes ?? [], scls.superclasses ?? []);
        fetchedMeta.current.add(id);
        setMeta((prev) => ({ ...prev, [id]: m }));
        const fresh = reconcile({ id, title, classes: [], superclasses: [] }, m, typeIds);
        const next = [...configs, fresh];
        setConfigs(next);
        onSave({ configs: next });
      } catch {
        // Конфиг не прочитался — пустая таблица без сохранения до ответа media-center
        setConfigs((prev) => [...prev, { id, title, classes: [], superclasses: [] }]);
      }
    },
    [configs, known, typeIds, onSave],
  );

  const setRule = (ci: number, kind: RuleKind, key: string, patch: Partial<GwTaxonomyRule>) => {
    setConfigs((prev) =>
      prev.map((c, i) =>
        i !== ci
          ? c
          : { ...c, [kind]: c[kind].map((r) => (r.key.toLowerCase() === key.toLowerCase() ? { ...r, ...patch } : r)) },
      ),
    );
  };

  const removeConfig = (id: string) => {
    fetchedMeta.current.delete(id);
    const next = configs.filter((c) => c.id !== id);
    setConfigs(next);
    onSave({ configs: next });
  };

  // Секция configs у шлюза заменяется целиком
  const saveConfigs = (ci: number) => {
    const c = configs[ci];
    const bad = c?.classes.find((r) => r.type !== INHERIT && !typeIds.has(r.type));
    if (bad) {
      setError(`«${c.title || c.id}»: у класса «${bad.title || bad.key}» недопустимый тип.`);
      return;
    }
    setError('');
    onSave({ configs });
  };

  // Камеры сохраняем сразу; повтор номера гасим локально
  const commitCameras = (next: GwTaxonomyCamera[]) => {
    setCameras(next);
    const bits = new Set<number>();
    for (const c of next) {
      if (!c.key.trim()) {
        setError('У каждой камеры должен быть camera_id.');
        return;
      }
      if (bits.has(c.bit)) {
        setError(`Номер ${c.bit} назначен двум камерам — выберите другой.`);
        return;
      }
      bits.add(c.bit);
    }
    setError('');
    onSave({ cameras: next });
  };

  // Новой камере — первый свободный номер
  const addCamera = (id: string, name: string) => {
    if (!id || cameras.some((c) => c.key === id)) return;
    const used = new Set(cameras.map((c) => c.bit));
    const bit = Array.from({ length: 8 }, (_, i) => i + 1).find((b) => !used.has(b)) ?? 1;
    commitCameras([...cameras, { key: id, title: name, bit }]);
  };

  if (!taxonomy) {
    return <div className="mod-loading"><span className="spin" /></div>;
  }

  const free = known.filter((k) => !configs.some((c) => c.id === k.id));
  const freeCameras = knownCameras.filter((k) => !cameras.some((c) => c.key === k.id));

  // Классы в порядке групп: строки одного суперкласса идут подряд
  const orderedClasses = (m: ConfigMeta): ClassMeta[] => {
    const out: ClassMeta[] = [];
    for (const s of m.supers) out.push(...m.classes.filter((c) => c.superKey === s.key));
    out.push(...m.classes.filter((c) => !m.supers.some((s) => s.key === c.superKey)));
    return out;
  };

  const cameraName = (c: GwTaxonomyCamera) => knownCameras.find((k) => k.id === c.key)?.name || c.title || c.key;

  return (
    <>
      <div className="mod-title">
        <h2>Таблица соответствий</h2>
        <span className="pill">{configs.length} {plural(configs.length, 'таблица', 'таблицы', 'таблиц')}</span>
        <span className="pill">
          <span className="seps">
            <span>умолчания</span>
            <span>тип {defaults.type}</span>
            <span>опасность {defaults.danger}</span>
          </span>
        </span>
        <div className="title-sel spacer">
          <span className="cap">Новая таблица</span>
          {free.length > 0 ? (
            <Select
              value=""
              disabled={busy}
              placeholder="— выберите конфигурацию нейросети —"
              options={free.map((k) => ({ value: k.id, label: k.name, hint: k.id }))}
              onChange={addConfig}
            />
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {known.length === 0 ? 'нет конфигураций нейросети' : 'все конфигурации добавлены'}
            </span>
          )}
        </div>
      </div>

      <div className="mod-rows">
        {configs.map((c, ci) => {
          const m = meta[c.id];
          const supers = m ? m.supers : c.superclasses.map((r) => ({ key: r.key, name: r.title, color: NEUTRAL }));
          return (
            <div className="card" key={c.id}>
              <div className="card-h">
                <h3>{c.title || c.id}</h3>
                <span className="id">{c.id}</span>
                <span className="meta">
                  <span className="seps">
                    <span>
                      {c.classes.length} {plural(c.classes.length, 'класс', 'класса', 'классов')}
                    </span>
                    <span>
                      {c.superclasses.length}{' '}
                      {plural(c.superclasses.length, 'суперкласс', 'суперкласса', 'суперклассов')}
                    </span>
                  </span>
                </span>
                <button type="button" className="icon-btn" title="Удалить таблицу конфигурации" onClick={() => removeConfig(c.id)}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
              <div className="card-b">
                <span className="eyebrow">
                  <span className="seps">
                    <span>Суперклассы</span>
                    <span>опасность на всю группу</span>
                  </span>
                </span>
                <div className="gt">
                  <table className="spec">
                    <thead>
                      <tr>
                        <th style={{ width: '50%' }}>Суперкласс (scls)</th>
                        <th style={{ width: '50%' }}>Класс опасности</th>
                      </tr>
                    </thead>
                    <tbody>
                      {supers.map((s) => {
                        const rule = findRule(c.superclasses, s.key);
                        return (
                          <tr key={s.key}>
                            <td className="name big">
                              <span className="swk"><i style={{ background: s.color }} /><b>{s.name}</b></span>
                              <span>{s.key}</span>
                            </td>
                            <td>
                              <Sel
                                value={rule?.danger ?? INHERIT}
                                items={dangers}
                                placeholder={`по умолчанию · ${dangerTitle(defaults.danger)}`}
                                onChange={(v) => setRule(ci, 'superclasses', s.key, { danger: v })}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {supers.length === 0 && (
                        <tr><td colSpan={2} className="dim">Суперклассов в конфигурации нет</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <span className="eyebrow">
                  <span className="seps">
                    <span>Классы</span>
                    <span>тип по id, опасность от группы</span>
                  </span>
                </span>
                <div className="gt">
                  <table className="spec">
                    <thead>
                      <tr>
                        <th style={{ width: 52 }}>id</th>
                        <th style={{ width: 200 }}>Класс (cls)</th>
                        <th style={{ width: 170 }}>Суперкласс</th>
                        <th>Тип обнаружения</th>
                        <th style={{ width: 290 }}>Класс опасности</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m ? (
                        orderedClasses(m).map((cm) => {
                          const rule = findRule(c.classes, cm.key);
                          const superName = m.supers.find((s) => s.key === cm.superKey)?.name;
                          const superDanger = findRule(c.superclasses, cm.superKey)?.danger ?? INHERIT;
                          const inheritedDanger = superDanger || defaults.danger;
                          const typeChosen = typeIds.has(rule?.type ?? INHERIT);
                          const showFlag = !typeIds.has(cm.cid + 1) && !typeChosen;
                          return (
                            <tr
                              key={cm.key}
                              style={{
                                boxShadow: `inset 3px 0 0 ${cm.color}`,
                                background: `linear-gradient(90deg, ${rgba(cm.color, 0.12)}, ${rgba(cm.color, 0.02)} 60%, transparent)`,
                              }}
                            >
                              <td className="m">{Number.isFinite(cm.cid) ? cm.cid : '—'}</td>
                              <td className="name"><b>{cm.name}</b><span>{cm.key}</span></td>
                              <td>
                                {superName ? (
                                  <span className="swk"><i style={{ background: cm.color }} />{superName}</span>
                                ) : (
                                  <span className="muted">без группы</span>
                                )}
                              </td>
                              <td>
                                <div className="typecell">
                                  {showFlag && (
                                    <span
                                      className="flag"
                                      title={`id класса ${cm.cid} вне 0–7 — типа ${cm.cid + 1} в протоколе нет, выберите вручную`}
                                    >
                                      !
                                    </span>
                                  )}
                                  <Sel
                                    value={rule?.type ?? INHERIT}
                                    items={types}
                                    placeholder="— выберите тип —"
                                    onChange={(v) => setRule(ci, 'classes', cm.key, { type: v })}
                                  />
                                </div>
                              </td>
                              <td>
                                <Sel
                                  value={rule?.danger ?? INHERIT}
                                  items={dangers}
                                  placeholder={`↳ от группы · ${dangerTitle(inheritedDanger)}`}
                                  onChange={(v) => setRule(ci, 'classes', cm.key, { danger: v })}
                                />
                              </td>
                            </tr>
                          );
                        })
                      ) : c.classes.length ? (
                        c.classes.map((r) => (
                          <tr key={r.key}>
                            <td className="m">—</td>
                            <td className="name"><b>{r.title || r.key}</b><span>{r.key}</span></td>
                            <td className="muted">—</td>
                            <td>
                              <Sel
                                value={r.type}
                                items={types}
                                placeholder="— выберите тип —"
                                onChange={(v) => setRule(ci, 'classes', r.key, { type: v })}
                              />
                            </td>
                            <td>
                              <Sel
                                value={r.danger}
                                items={dangers}
                                placeholder={`↳ от группы · ${dangerTitle(defaults.danger)}`}
                                onChange={(v) => setRule(ci, 'classes', r.key, { danger: v })}
                              />
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="dim">
                            {fetchedMeta.current.has(c.id) ? 'Классов в конфигурации нет' : 'Загрузка классов…'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="card-f">
                <button type="button" className="btn btn--acc spacer" onClick={() => saveConfigs(ci)} disabled={busy}>
                  Сохранить таблицу
                </button>
              </div>
            </div>
          );
        })}
        {configs.length === 0 && (
          <div className="card">
            <div className="card-b">
              <div className="empty"><b>Таблиц нет, шлюз берёт числа напрямую из нейросети</b></div>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-h">
            <h3>Номера камер</h3>
            <span className="meta">{cameras.length} из 8 номеров</span>
          </div>
          <div className="card-b">
            <div className="bitcards">
              {Array.from({ length: 8 }, (_, i) => {
                const bit = 8 - i;
                const cam = cameras.find((c) => c.bit === bit);
                return (
                  <div key={bit} className={`bitcard${cam ? ' is-set' : ''}`}>
                    <div className="n">{bit}</div>
                    <div className="l">номер</div>
                    <div className="c">{cam ? cameraName(cam) : 'свободен'}</div>
                  </div>
                );
              })}
            </div>

            <div className="gt">
              <table className="spec">
                <thead>
                  <tr>
                    <th>Камера</th>
                    <th style={{ width: 160 }}>camera_id</th>
                    <th style={{ width: 220 }}>Номер</th>
                    <th style={{ width: 44 }} />
                  </tr>
                </thead>
                <tbody>
                  {cameras.map((c, i) => (
                    <tr key={c.key}>
                      <td className="name"><b>{cameraName(c)}</b></td>
                      <td className="m" title={c.key}>{c.key}</td>
                      <td>
                        <Select
                          value={String(c.bit)}
                          options={Array.from({ length: 8 }, (_, b) => ({ value: String(b + 1), label: `номер ${b + 1}` }))}
                          onChange={(v) => commitCameras(cameras.map((x, j) => (j === i ? { ...x, bit: Number(v) } : x)))}
                        />
                      </td>
                      <td>
                        <button type="button" className="x" title="Убрать камеру" onClick={() => commitCameras(cameras.filter((_, j) => j !== i))}>
                          <Icon name="x" size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {cameras.length === 0 && (
                    <tr><td colSpan={4} className="dim">Камер пока нет</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="addline">
              <Icon name="plus" size={16} />
              Новая камера
              {cameras.length < 8 && freeCameras.length > 0 ? (
                <Select
                  value=""
                  disabled={busy}
                  placeholder="— выберите камеру технического зрения —"
                  options={freeCameras.map((k) => ({ value: k.id, label: k.name, hint: k.id }))}
                  onChange={(v) => {
                    const k = freeCameras.find((x) => x.id === v);
                    if (k) addCamera(k.id, k.name);
                  }}
                />
              ) : (
                <span className="note">
                  {cameras.length >= 8
                    ? 'все восемь номеров заняты'
                    : knownCameras.length === 0
                      ? 'камер технического зрения нет'
                      : 'все камеры технического зрения добавлены'}
                </span>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="card">
            <div className="card-b">
              <div className="banner is-err"><Icon name="warn" size={15} />{error}</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default TaxonomyPanel;
