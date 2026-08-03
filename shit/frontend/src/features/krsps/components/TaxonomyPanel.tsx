import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconClose, IconPlus, IconTune } from '../icons';
import type {
  GwTaxonomy,
  GwTaxonomyCamera,
  GwTaxonomyConfig,
  GwTaxonomyDictItem,
  GwTaxonomyPatch,
  GwTaxonomyRule,
} from '../types';
import { neuralApi } from '../../neural/api/client';
import type { ConfigSummary } from '../../neural/api/types';

// ECameraType::NEURAL из media-center (utility/data-structs.h): камеры, отдающие
// обнаружения. Только их и предлагаем для байта камер.
const CAMERA_TYPE_NEURAL = 2;

interface KnownCamera {
  id: string;
  name: string;
}

interface Props {
  taxonomy: GwTaxonomy | null;
  busy: boolean;
  onSave: (patch: GwTaxonomyPatch) => void;
}

// Таблица соответствий: имена, которыми оперирует нейросеть, против числовых id,
// которых требуют протоколы. Два независимых раздела.
//
// 1. Таблицы классов и суперклассов — свои у каждой конфигурации нейросети.
//    Имя класса, его id и суперкласс приходят из конфигурации нейросети и здесь
//    только читаются — настраиваются одни соответствия (селекты). Правки правил
//    сохраняются кнопкой внутри самой таблицы; добавление и удаление таблицы —
//    сразу, без кнопки.
// 2. Байт камер — вне конфигураций: камера физическая, от модели не зависит.
//    Любое изменение сохраняется сразу.
//
// Модель соответствий (см. media-center slot.cpp и gateway taxonomy.cpp):
//   • Тип обнаружения несёт сам класс: по умолчанию type = id класса (det.cid).
//     Если id вне диапазона протокола 1..8, прямого типа под него нет — перед
//     селектом горит красный флаг, пока тип не выбран вручную.
//   • Опасность задаёт суперкласс на всю группу, класс наследует её и может
//     переопределить. «Наследовать» в списке — это 0, «не задано».

const INHERIT = 0;

type RuleKind = 'classes' | 'superclasses';

// ── Метаданные конфигурации из media-center ──────────────────────────────────
// Живут только на клиенте: шлюз хранит лишь key/title/type/danger, а id класса,
// цвет и связь класс→суперкласс нужны для отображения и наследования. Читаем их
// у media-center и совмещаем с сохранёнными в шлюзе значениями.
interface SuperMeta {
  key: string;
  name: string;
  color: string;
}
interface ClassMeta {
  key: string;   // имя класса (cls), по нему шлюз ищет правило
  cid: number;   // id класса = тип обнаружения по умолчанию (det.cid)
  name: string;
  superKey: string;
  color: string; // цвет своего суперкласса — им подкрашивается строка
}
interface ConfigMeta {
  supers: SuperMeta[];
  classes: ClassMeta[];
}

const NEUTRAL = '#94a1ab';

// #rrggbb -> rgba с заданной прозрачностью для мягкой заливки строки.
const rgba = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(148,161,171,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ── Стабильные подкомпоненты уровня модуля ───────────────────────────────────
// Раньше строки таблицы жили функцией-компонентом внутри рендера: каждый рендер
// создавал новый тип, React размонтировал поддерево, и селект сбрасывался при
// первом же изменении. Держим их на уровне модуля.

const Sel: React.FC<{
  value: number;
  items: GwTaxonomyDictItem[];
  placeholder: string;
  onChange: (v: number) => void;
}> = ({ value, items, placeholder, onChange }) => (
  <select
    className={`krsps-input krsps-input--sm${value === INHERIT ? ' krsps-input--inherit' : ''}`}
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
  >
    <option value={INHERIT}>{placeholder}</option>
    {items.map((i) => (
      <option key={i.id} value={i.id}>
        {i.id} · {i.title}
      </option>
    ))}
  </select>
);

const Chevron: React.FC = () => (
  <svg className="krsps-chev" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5l8 7-8 7z" />
  </svg>
);

const findRule = (rules: GwTaxonomyRule[], key: string): GwTaxonomyRule | undefined =>
  rules.find((r) => r.key.toLowerCase() === key.toLowerCase());

// Сохранённые правила совмещаем со структурой модели: строки идут в порядке
// конфигурации, у нового класса — умолчания, исчезнувшего из модели — нет.
const reconcile = (cfg: GwTaxonomyConfig, m: ConfigMeta, typeIds: Set<number>): GwTaxonomyConfig => {
  const superclasses = m.supers.map((s) => {
    const ex = findRule(cfg.superclasses, s.key);
    return { key: s.key, title: s.name || s.key, type: INHERIT, danger: ex?.danger ?? INHERIT };
  });
  const classes = m.classes.map((c) => {
    const ex = findRule(cfg.classes, c.key);
    const defType = typeIds.has(c.cid) ? c.cid : INHERIT;
    return { key: c.key, title: c.name || c.key, type: ex?.type ?? defType, danger: ex?.danger ?? INHERIT };
  });
  return { ...cfg, superclasses, classes };
};

// Метаданные модели -> ConfigMeta. Отдельно, потому что нужны и при загрузке
// сохранённых таблиц, и при добавлении новой.
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

const TaxonomyPanel: React.FC<Props> = ({ taxonomy, busy, onSave }) => {
  const [configs, setConfigs] = useState<GwTaxonomyConfig[]>([]);
  const [meta, setMeta] = useState<Record<string, ConfigMeta>>({});
  const [cameras, setCameras] = useState<GwTaxonomyCamera[]>([]);
  const [error, setError] = useState('');

  // Списки из media-center — чтобы конфигурации и камеры выбирали из готового, а
  // не вбивали id руками и не промахивались.
  const [known, setKnown] = useState<ConfigSummary[]>([]);
  const [knownCameras, setKnownCameras] = useState<KnownCamera[]>([]);

  // config_id, для которых метаданные уже запрашивали — чтобы не дёргать
  // media-center на каждый рендер.
  const fetchedMeta = useRef<Set<string>>(new Set());

  const types = useMemo<GwTaxonomyDictItem[]>(() => taxonomy?.types ?? [], [taxonomy]);
  const dangers = useMemo<GwTaxonomyDictItem[]>(() => taxonomy?.dangers ?? [], [taxonomy]);
  const typeIds = useMemo(() => new Set(types.map((t) => t.id)), [types]);
  const defaults = taxonomy?.defaults ?? { type: 0, danger: 0 };
  const dangerTitle = (id: number) => dangers.find((d) => d.id === id)?.title ?? `класс ${id}`;

  // Разделы читаем по одному и с запасом: шлюз может быть старее страницы и не
  // отдавать секцию целиком.
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
    neuralApi
      .listConfigurations()
      .then((r) => {
        if (!stop) setKnown(r.configurations ?? []);
      })
      .catch(() => {
        /* media-center недоступен — таблицу можно только смотреть */
      });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    let stop = false;
    neuralApi
      .listCameras()
      .then((r) => {
        if (stop) return;
        const list = Object.entries(r.cameras ?? {})
          .filter(([, c]) => c.camera_type === CAMERA_TYPE_NEURAL || c.type === CAMERA_TYPE_NEURAL)
          .map(([id, c]) => ({ id, name: c.display_name || id }));
        setKnownCameras(list);
      })
      .catch(() => {
        /* media-center недоступен — список камер останется пустым */
      });
    return () => {
      stop = true;
    };
  }, []);

  // Метаданные подтягиваем на каждый config_id, загруженный из шлюза. Ключ
  // эффекта — только список id, поэтому правки значений его не перезапускают.
  // Добавленные вручную таблицы метаданные получают сразу в addConfig, эффект их
  // пропускает.
  const configIdsKey = configs.map((c) => c.id).join('|');
  useEffect(() => {
    const ids = configIdsKey ? configIdsKey.split('|') : [];
    ids.forEach((id) => {
      if (!id || fetchedMeta.current.has(id)) return;
      fetchedMeta.current.add(id);
      Promise.all([neuralApi.getClasses(id), neuralApi.getSuperclasses(id)])
        .then(([cls, scls]) => {
          const m = buildMeta(cls.classes ?? [], scls.superclasses ?? []);
          setMeta((prev) => ({ ...prev, [id]: m }));
          setConfigs((prev) => prev.map((c) => (c.id === id ? reconcile(c, m, typeIds) : c)));
        })
        .catch(() => {
          fetchedMeta.current.delete(id);
        });
    });
    // typeIds стабилен между сменами словаря; на его смену дозаполнять не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configIdsKey]);

  // Новая таблица: тянем структуру модели, заполняем умолчаниями и сразу
  // сохраняем — добавление таблицы кнопки не требует.
  const addConfig = useCallback(
    async (id: string) => {
      if (!id || configs.some((c) => c.id === id)) return;
      const title = known.find((k) => k.id === id)?.name ?? id;
      try {
        const [cls, scls] = await Promise.all([neuralApi.getClasses(id), neuralApi.getSuperclasses(id)]);
        const m = buildMeta(cls.classes ?? [], scls.superclasses ?? []);
        fetchedMeta.current.add(id);
        setMeta((prev) => ({ ...prev, [id]: m }));
        const fresh = reconcile({ id, title, classes: [], superclasses: [] }, m, typeIds);
        const next = [...configs, fresh];
        setConfigs(next);
        onSave({ configs: next });
      } catch {
        // Конфиг не прочитался — заведём пустую таблицу без сохранения, правила
        // появятся, когда media-center снова ответит.
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

  // Удаление таблицы — сразу сохраняем: структурная правка кнопки не ждёт.
  const removeConfig = (id: string) => {
    fetchedMeta.current.delete(id);
    const next = configs.filter((c) => c.id !== id);
    setConfigs(next);
    onSave({ configs: next });
  };

  // Кнопка внутри таблицы конфигурации сохраняет правила соответствий. Секция
  // configs у шлюза заменяется целиком, поэтому отправляем весь список.
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

  // Камеры сохраняем сразу на любое изменение. Конфликт битов гасим локально:
  // шлюз такой набор отклонит, поэтому в него не шлём.
  const commitCameras = (next: GwTaxonomyCamera[]) => {
    setCameras(next);
    const bits = new Set<number>();
    for (const c of next) {
      if (!c.key.trim()) {
        setError('У каждой камеры должен быть camera_id.');
        return;
      }
      if (bits.has(c.bit)) {
        setError(`Бит ${c.bit} назначен двум камерам — выберите другой.`);
        return;
      }
      bits.add(c.bit);
    }
    setError('');
    onSave({ cameras: next });
  };

  // Назначаем камере первый свободный бит: занятый пришлось бы искать глазами.
  const addCamera = (id: string, name: string) => {
    if (!id || cameras.some((c) => c.key === id)) return;
    const used = new Set(cameras.map((c) => c.bit));
    const bit = Array.from({ length: 8 }, (_, i) => i + 1).find((b) => !used.has(b)) ?? 1;
    commitCameras([...cameras, { key: id, title: name, bit }]);
  };

  if (!taxonomy) {
    return <div className="krsps-empty">Загрузка таблицы соответствий…</div>;
  }

  const free = known.filter((k) => !configs.some((c) => c.id === k.id));
  const freeCameras = knownCameras.filter((k) => !cameras.some((c) => c.key === k.id));

  // Классы в порядке групп: строки одного суперкласса идут подряд, поэтому
  // одинаковый фон отделяет группу от соседней без отдельных заголовков.
  const orderedClasses = (m: ConfigMeta): ClassMeta[] => {
    const out: ClassMeta[] = [];
    for (const s of m.supers) out.push(...m.classes.filter((c) => c.superKey === s.key));
    out.push(...m.classes.filter((c) => !m.supers.some((s) => s.key === c.superKey)));
    return out;
  };

  // Читаемое имя камеры — из списка media-center, это справочное поле. Если
  // камеры там уже нет, показываем сохранённое название.
  const cameraName = (c: GwTaxonomyCamera) => knownCameras.find((k) => k.id === c.key)?.name || c.title || c.key;

  return (
    <div>
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <IconTune />
          <div className="krsps-panel__title">Как это работает</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-note">
            Нейросеть отдаёт имена: класс (<code>cls</code>) и суперкласс (<code>scls</code>). Протоколы
            требуют числа: тип обнаружения 1–8 и класс опасности 1–4. Имя класса, его <b>id</b> и суперкласс
            приходят из конфигурации нейросети — их видно, но не редактируют; настраиваются одни соответствия.
            <br />
            <br />
            <b>Тип обнаружения несёт сам класс</b>: по умолчанию он равен id класса. Если id выходит за
            диапазон 1–8, прямого типа под него нет — перед селектом горит <span style={{ color: 'var(--k-accent)' }}>красный
            знак</span>, пока тип не выбран вручную. <b>Опасность задаёт суперкласс</b> на всю группу, класс её
            наследует и может переопределить. Нет соответствия — берутся умолчания (тип {defaults.type}, опасность{' '}
            {defaults.danger}).
          </div>
        </div>
      </div>

      {/* ── Раздел 1: таблицы по конфигурациям ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Классы и суперклассы по конфигурациям</div>
          <div className="krsps-panel__meta">{configs.length} таблиц</div>
        </div>

        <div className="krsps-txscroll">
          {configs.map((c, ci) => {
            const m = meta[c.id];
            return (
              <details className="krsps-msg" key={c.id} open>
                <summary className="krsps-msg__head">
                  <Chevron />
                  <span className="krsps-msg__name">{c.title || c.id}</span>
                  <span className="krsps-msg__id">{c.id}</span>
                  <span className="krsps-msg__spacer" />
                  <span className="krsps-msg__hz">
                    {c.classes.length} классов · {c.superclasses.length} суперклассов
                  </span>
                  <button
                    type="button"
                    className="krsps-icon-btn"
                    title="Удалить таблицу конфигурации"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeConfig(c.id);
                    }}
                  >
                    <IconClose />
                  </button>
                </summary>
                <div className="krsps-msg__body">
                  {/* Суперклассы — сверху, настраиваются первыми: их опасность
                      наследуют классы. Тип суперкласс не задаёт. */}
                  <div className="krsps-sub">Суперклассы · опасность на всю группу</div>
                  <div className="krsps-tbl krsps-tbl--super">
                    <div className="krsps-tbl__head">
                      <div>Суперкласс (scls)</div>
                      <div>Класс опасности</div>
                      <div />
                    </div>
                    {(m ? m.supers : c.superclasses.map((r) => ({ key: r.key, name: r.title, color: NEUTRAL }))).map(
                      (s) => {
                        const rule = findRule(c.superclasses, s.key);
                        return (
                          <div className="krsps-tbl__row" key={s.key}>
                            <div className="krsps-tbl__super">
                              <span className="krsps-tbl__super-dot" style={{ background: s.color }} />
                              <div className="krsps-tbl__name">
                                <b>{s.name}</b>
                                <small>{s.key}</small>
                              </div>
                            </div>
                            <Sel
                              value={rule?.danger ?? INHERIT}
                              items={dangers}
                              placeholder={`по умолчанию · ${dangerTitle(defaults.danger)}`}
                              onChange={(v) => setRule(ci, 'superclasses', s.key, { danger: v })}
                            />
                            <span />
                          </div>
                        );
                      },
                    )}
                    {(m ? m.supers.length : c.superclasses.length) === 0 && (
                      <div className="krsps-empty">Суперклассов в конфигурации нет</div>
                    )}
                  </div>

                  {/* Классы — снизу. id, имя и суперкласс только читаются;
                      настраиваются тип и опасность. Строка подкрашена цветом
                      своего суперкласса. */}
                  <div className="krsps-sub">Классы · тип по id, опасность от группы</div>
                  <div className="krsps-tbl krsps-tbl--cls">
                    <div className="krsps-tbl__head">
                      <div>id</div>
                      <div>Класс (cls)</div>
                      <div>Суперкласс</div>
                      <div>Тип обнаружения</div>
                      <div>Класс опасности</div>
                      <div />
                    </div>
                    {m ? (
                      orderedClasses(m).map((cm) => {
                        const rule = findRule(c.classes, cm.key);
                        const superName = m.supers.find((s) => s.key === cm.superKey)?.name;
                        const superDanger = findRule(c.superclasses, cm.superKey)?.danger ?? INHERIT;
                        const inheritedDanger = superDanger || defaults.danger;
                        // Флаг о несоответствии id и типа: id класса вне 1..8 и
                        // валидный тип ещё не выбран вручную.
                        const typeChosen = typeIds.has(rule?.type ?? INHERIT);
                        const showFlag = !typeIds.has(cm.cid) && !typeChosen;
                        return (
                          <div
                            className="krsps-tbl__row krsps-tbl__row--tinted"
                            key={cm.key}
                            style={{
                              borderLeftColor: cm.color,
                              background: `linear-gradient(90deg, ${rgba(cm.color, 0.12)}, ${rgba(cm.color, 0.02)} 55%, transparent)`,
                            }}
                          >
                            <div className="krsps-tbl__cid">{Number.isFinite(cm.cid) ? cm.cid : '—'}</div>
                            <div className="krsps-tbl__name">
                              <b>{cm.name}</b>
                              <small>{cm.key}</small>
                            </div>
                            {superName ? (
                              <div className="krsps-tbl__super">
                                <span className="krsps-tbl__super-dot" style={{ background: cm.color }} />
                                <span>{superName}</span>
                              </div>
                            ) : (
                              <div className="krsps-tbl__super krsps-tbl__super--none">без группы</div>
                            )}
                            <div className="krsps-tbl__typecell">
                              {showFlag && (
                                <span
                                  className="krsps-flag"
                                  title={`id класса ${cm.cid} вне диапазона типов 1–8 — прямого типа под него нет, выберите вручную`}
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
                            <Sel
                              value={rule?.danger ?? INHERIT}
                              items={dangers}
                              placeholder={`↳ от группы · ${dangerTitle(inheritedDanger)}`}
                              onChange={(v) => setRule(ci, 'classes', cm.key, { danger: v })}
                            />
                            <span />
                          </div>
                        );
                      })
                    ) : c.classes.length ? (
                      c.classes.map((r) => (
                        <div className="krsps-tbl__row" key={r.key}>
                          <div className="krsps-tbl__cid">—</div>
                          <div className="krsps-tbl__name">
                            <b>{r.title || r.key}</b>
                            <small>{r.key}</small>
                          </div>
                          <div className="krsps-tbl__super krsps-tbl__super--none">—</div>
                          <div className="krsps-tbl__typecell">
                            <Sel
                              value={r.type}
                              items={types}
                              placeholder="— выберите тип —"
                              onChange={(v) => setRule(ci, 'classes', r.key, { type: v })}
                            />
                          </div>
                          <Sel
                            value={r.danger}
                            items={dangers}
                            placeholder={`↳ от группы · ${dangerTitle(defaults.danger)}`}
                            onChange={(v) => setRule(ci, 'classes', r.key, { danger: v })}
                          />
                          <span />
                        </div>
                      ))
                    ) : (
                      <div className="krsps-empty">
                        {fetchedMeta.current.has(c.id) ? 'Классов в конфигурации нет' : 'Загрузка классов…'}
                      </div>
                    )}
                  </div>

                  {/* Кнопка сохранения относится ровно к этой таблице и висит у
                      её правого нижнего края. */}
                  <div className="krsps-savepin">
                    <button
                      type="button"
                      className="krsps-btn krsps-btn--primary"
                      onClick={() => saveConfigs(ci)}
                      disabled={busy}
                    >
                      Сохранить таблицу
                    </button>
                  </div>
                </div>
              </details>
            );
          })}
          {configs.length === 0 && (
            <div className="krsps-empty">Таблиц нет, шлюз берёт числа напрямую из нейросети</div>
          )}

          {/* Добавление одним движением: выбрал конфигурацию — таблица создаётся
              и сохраняется сразу. Настроить её можно тут же. */}
          {free.length > 0 ? (
            <div className="krsps-addline">
              <span className="krsps-addline__lead">
                <IconPlus />
                Новая таблица
              </span>
              <select
                className="krsps-input krsps-input--sm"
                value=""
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value) addConfig(e.target.value);
                }}
              >
                <option value="">— выберите конфигурацию нейросети —</option>
                {free.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} · {k.id}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="krsps-addline krsps-addline--off">
              <span className="krsps-addline__lead">
                <IconPlus />
                Новая таблица
              </span>
              <span className="krsps-addline__note">
                {known.length === 0 ? 'Нет конфигураций для создания таблиц' : 'Все конфигурации уже добавлены'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Раздел 2: байт камер ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Байт камер</div>
          <div className="krsps-panel__meta">{cameras.length} из 8 бит</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-note" style={{ marginBottom: 14 }}>
            Камера занимает <b>один бит</b> в байте камер, а не номер целиком. Поэтому в одном кадре видно
            сразу несколько камер, поймавших обнаружение. Имя камеры — справочное, из списка вычислительного
            устройства; настраивается только бит. Изменения сохраняются сразу.
          </div>

          <div className="krsps-bitline">
            {Array.from({ length: 8 }, (_, i) => {
              const bit = 8 - i;
              const cam = cameras.find((c) => c.bit === bit);
              return (
                <div key={bit} className={`krsps-bitbox${cam ? ' krsps-bitbox--set' : ''}`}>
                  <div className="krsps-bitbox__v">{bit}</div>
                  <div className="krsps-bitbox__n">бит</div>
                  <div className="krsps-bitbox__c">{cam ? cameraName(cam) : 'свободен'}</div>
                </div>
              );
            })}
          </div>

          <div className="krsps-tbl krsps-tbl--cam">
            <div className="krsps-tbl__head">
              <div>Камера</div>
              <div>camera_id</div>
              <div>Бит</div>
              <div />
            </div>
            {cameras.map((c, i) => (
              <div className="krsps-tbl__row" key={c.key}>
                {/* Имя и camera_id только читаются: камера выбрана из списка. */}
                <div className="krsps-tbl__name">
                  <b>{cameraName(c)}</b>
                </div>
                <div className="krsps-tbl__key" title={c.key}>
                  {c.key}
                </div>
                <select
                  className="krsps-input krsps-input--sm"
                  value={c.bit}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    commitCameras(cameras.map((x, j) => (j === i ? { ...x, bit: v } : x)));
                  }}
                >
                  {Array.from({ length: 8 }, (_, b) => (
                    <option key={b + 1} value={b + 1}>
                      бит {b + 1} · маска 0x{(1 << b).toString(16).toUpperCase().padStart(2, '0')}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="krsps-icon-btn"
                  title="Убрать камеру"
                  onClick={() => commitCameras(cameras.filter((_, j) => j !== i))}
                >
                  <IconClose />
                </button>
              </div>
            ))}
            {cameras.length === 0 && <div className="krsps-empty">Камер пока нет</div>}
          </div>

          {/* Добавление камеры строкой — выбором из neural-камер. */}
          {cameras.length < 8 && freeCameras.length > 0 ? (
            <div className="krsps-addline">
              <span className="krsps-addline__lead">
                <IconPlus />
                Новая камера
              </span>
              <select
                className="krsps-input krsps-input--sm"
                value=""
                disabled={busy}
                onChange={(e) => {
                  const k = freeCameras.find((x) => x.id === e.target.value);
                  if (k) addCamera(k.id, k.name);
                }}
              >
                <option value="">— выберите камеру neural —</option>
                {freeCameras.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} · {k.id}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="krsps-addline krsps-addline--off">
              <span className="krsps-addline__lead">
                <IconPlus />
                Новая камера
              </span>
              <span className="krsps-addline__note">
                {cameras.length >= 8
                  ? 'Все восемь бит заняты'
                  : knownCameras.length === 0
                    ? 'Нет камер технического зрения — вычислительное устройство недоступно либо их нет'
                    : 'Все камеры технического зрения уже добавлены'}
              </span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="krsps-card">
          <div className="krsps-panel__body">
            <div className="krsps-field__hint krsps-field__hint--error">{error}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaxonomyPanel;
