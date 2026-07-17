import React, { useCallback, useEffect, useState } from 'react';
import { IconClose, IconTune } from '../icons';
import type {
  GwTaxonomy,
  GwTaxonomyCamera,
  GwTaxonomyConfig,
  GwTaxonomyPatch,
  GwTaxonomyRule,
} from '../types';
import { neuralApi } from '../../neural/api/client';
import type { ConfigSummary } from '../../neural/api/types';

interface Props {
  taxonomy: GwTaxonomy | null;
  busy: boolean;
  onSave: (patch: GwTaxonomyPatch) => void;
}

// Таблица соответствий: имена, которыми оперирует нейросеть, против числовых id,
// которых требуют протоколы. Два независимых раздела.
//
// 1. Таблицы классов и суперклассов — свои у каждой конфигурации нейросети:
//    имена классов задаёт конфиг модели, и в разных конфигурациях один и тот же
//    «person» может значить разное. Пока таблицы для конфигурации нет, шлюз
//    работает напрямую — берёт числа как пришли по gRPC.
// 2. Байт камер — вне конфигураций: камера физическая, от модели не зависит.
//
// Приоритет внутри таблицы: правило класса перекрывает правило суперкласса,
// причём только заданными полями. «Наследовать» в списке — это 0, «не задано».

const INHERIT = 0;

type RuleKind = 'classes' | 'superclasses';

const Select: React.FC<{
  value: number;
  items: Array<{ id: number; title: string }>;
  inheritLabel: string;
  onChange: (v: number) => void;
}> = ({ value, items, inheritLabel, onChange }) => (
  <select className="krsps-input krsps-input--sm" value={value} onChange={(e) => onChange(Number(e.target.value))}>
    <option value={INHERIT}>{inheritLabel}</option>
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

const TaxonomyPanel: React.FC<Props> = ({ taxonomy, busy, onSave }) => {
  const [configs, setConfigs] = useState<GwTaxonomyConfig[]>([]);
  const [cameras, setCameras] = useState<GwTaxonomyCamera[]>([]);
  const [error, setError] = useState('');

  // Список конфигураций нейросети — из media-center, чтобы id не вбивали руками
  // и не промахивались: по нему шлюз ищет таблицу.
  const [known, setKnown] = useState<ConfigSummary[]>([]);
  const [adding, setAdding] = useState('');

  // Разделы таблицы читаем по одному и с запасом: шлюз может быть старее
  // страницы и не отдавать секцию целиком. Пустой раздел показать можно,
  // а undefined в состоянии уронил бы весь раздел.
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
        /* media-center недоступен — id можно ввести руками */
      });
    return () => {
      stop = true;
    };
  }, []);

  // Новая таблица заполняется классами самой модели: вбивать их руками — это
  // гарантированные опечатки, а по опечатке правило молча не сработает.
  const addConfig = useCallback(
    async (id: string) => {
      if (!id || configs.some((c) => c.id === id)) return;
      const title = known.find((k) => k.id === id)?.name ?? id;

      let classes: GwTaxonomyRule[] = [];
      let supers: GwTaxonomyRule[] = [];
      try {
        const [cls, scls] = await Promise.all([neuralApi.getClasses(id), neuralApi.getSuperclasses(id)]);
        // Ключи должны совпадать с тем, что media-center кладёт в кадр:
        // cls — имя класса, scls — ключ суперкласса.
        classes = (cls.classes ?? []).map((c) => ({
          key: c.name,
          title: c.name,
          type: INHERIT,
          danger: INHERIT,
        }));
        supers = (scls.superclasses ?? []).map((s) => ({
          key: s.key,
          title: s.name,
          type: INHERIT,
          danger: INHERIT,
        }));
      } catch {
        /* конфиг не прочитался — заведём пустую таблицу, правила добавят руками */
      }

      setConfigs((prev) => [...prev, { id, title, classes, superclasses: supers }]);
      setAdding('');
    },
    [configs, known],
  );

  if (!taxonomy) {
    return <div className="krsps-empty">Загрузка таблицы соответствий…</div>;
  }

  // Словари протокола и умолчания приходят от шлюза. Их отсутствие — тоже
  // старая сборка: списки просто останутся с одним пунктом «не задано».
  const types = taxonomy.types ?? [];
  const dangers = taxonomy.dangers ?? [];
  const defaults = taxonomy.defaults ?? { type: 0, danger: 0 };

  const patchRule = (ci: number, kind: RuleKind, i: number, patch: Partial<GwTaxonomyRule>) => {
    const next = configs.slice();
    const rules = next[ci][kind].slice();
    rules[i] = { ...rules[i], ...patch };
    next[ci] = { ...next[ci], [kind]: rules };
    setConfigs(next);
  };

  const addRule = (ci: number, kind: RuleKind) => {
    const next = configs.slice();
    next[ci] = { ...next[ci], [kind]: [...next[ci][kind], { key: '', title: '', type: INHERIT, danger: INHERIT }] };
    setConfigs(next);
  };

  const removeRule = (ci: number, kind: RuleKind, i: number) => {
    const next = configs.slice();
    next[ci] = { ...next[ci], [kind]: next[ci][kind].filter((_, j) => j !== i) };
    setConfigs(next);
  };

  const dupe = (rs: Array<{ key: string }>) => {
    const seen = new Set<string>();
    return rs.find((r) => {
      const k = r.key.trim().toLowerCase();
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
  };

  const handleSave = () => {
    for (const c of configs) {
      const all = [...c.classes, ...c.superclasses];
      if (all.some((r) => !r.key.trim())) {
        setError(`«${c.title || c.id}»: у каждого правила должно быть имя класса.`);
        return;
      }
      const d = dupe(c.classes) ?? dupe(c.superclasses);
      if (d) {
        setError(`«${c.title || c.id}»: имя «${d.key}» встречается дважды.`);
        return;
      }
    }
    if (cameras.some((c) => !c.key.trim())) {
      setError('У каждой камеры должен быть camera_id.');
      return;
    }
    const dc = dupe(cameras);
    if (dc) {
      setError(`Камера «${dc.key}» встречается дважды.`);
      return;
    }
    const bits = new Set<number>();
    for (const c of cameras) {
      if (bits.has(c.bit)) {
        setError(`Бит ${c.bit} назначен двум камерам — обнаружения слились бы в одно.`);
        return;
      }
      bits.add(c.bit);
    }
    setError('');
    onSave({ configs, cameras });
  };

  const RuleTable: React.FC<{ ci: number; kind: RuleKind; rules: GwTaxonomyRule[] }> = ({ ci, kind, rules }) => (
    <>
      <div className="krsps-tbl">
        <div className="krsps-tbl__head">
          <div>{kind === 'classes' ? 'Класс нейросети (cls)' : 'Суперкласс (scls)'}</div>
          <div>Читаемое название</div>
          <div>Тип обнаружения</div>
          <div>Класс опасности</div>
          <div />
        </div>
        {rules.map((r, i) => (
          <div className="krsps-tbl__row" key={i}>
            <input
              className="krsps-input krsps-input--sm"
              value={r.key}
              spellCheck={false}
              placeholder={kind === 'classes' ? 'person' : 'human'}
              onChange={(e) => patchRule(ci, kind, i, { key: e.target.value })}
            />
            <input
              className="krsps-input krsps-input--sm"
              value={r.title}
              placeholder="Человек"
              onChange={(e) => patchRule(ci, kind, i, { title: e.target.value })}
            />
            <Select
              value={r.type}
              items={types}
              inheritLabel={kind === 'classes' ? 'от суперкласса' : 'по умолчанию'}
              onChange={(v) => patchRule(ci, kind, i, { type: v })}
            />
            <Select
              value={r.danger}
              items={dangers}
              inheritLabel={kind === 'classes' ? 'от суперкласса' : 'по умолчанию'}
              onChange={(v) => patchRule(ci, kind, i, { danger: v })}
            />
            <button type="button" className="krsps-icon-btn" title="Удалить правило" onClick={() => removeRule(ci, kind, i)}>
              <IconClose />
            </button>
          </div>
        ))}
        {rules.length === 0 && <div className="krsps-empty">Правил пока нет</div>}
      </div>
      <button type="button" className="krsps-btn krsps-btn--ghost" onClick={() => addRule(ci, kind)}>
        Добавить правило
      </button>
    </>
  );

  const free = known.filter((k) => !configs.some((c) => c.id === k.id));

  return (
    <div>
      <div className="krsps-module__head">
        <div className="krsps-module__title">Таблица соответствий</div>
        <div className="krsps-module__meta">общая для всех модулей и конфигураций</div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <IconTune />
          <div className="krsps-panel__title">Как это работает</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-note">
            Нейросеть отдаёт имена: класс (<code>cls</code>) и суперкласс (<code>scls</code>). Протоколы
            требуют числа: тип обнаружения 1–8 и класс опасности 1–4. Имена задаются конфигом модели, поэтому
            таблица у каждой конфигурации своя — шлюз выбирает её по <code>config_id</code>, который
            media-center шлёт вместе с кадром. <b>Правило класса перекрывает правило суперкласса</b>, но
            только заданными полями: можно уточнить классу лишь опасность, а тип оставить от группы. Нет
            соответствия — берутся умолчания (тип {defaults.type}, опасность {defaults.danger}).
            <br />
            <br />
            Пока для конфигурации таблицы нет, шлюз работает <b>напрямую</b>: числа идут как пришли по gRPC
            (тип = id класса), имена не переводятся. Шина при этом живая — таблицу можно завести позже.
          </div>
        </div>
      </div>

      {/* ── Раздел 1: таблицы по конфигурациям ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Классы и суперклассы по конфигурациям</div>
          <div className="krsps-panel__meta">{configs.length} таблиц</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-form__row">
            <div className="krsps-field krsps-field--mid">
              <label className="krsps-field__label" htmlFor="krsps-tax-add">
                Добавить таблицу для конфигурации
              </label>
              <input
                id="krsps-tax-add"
                className="krsps-input krsps-input--sm"
                list="krsps-tax-configs"
                value={adding}
                spellCheck={false}
                placeholder="railway_camera"
                onChange={(e) => setAdding(e.target.value)}
              />
              <datalist id="krsps-tax-configs">
                {free.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </datalist>
              <div className="krsps-field__hint">
                {known.length
                  ? 'Классы модели подставятся сами — останется проставить типы и опасность'
                  : 'Список конфигураций недоступен, введите config_id вручную'}
              </div>
            </div>
            <button
              type="button"
              className="krsps-btn krsps-btn--primary"
              onClick={() => addConfig(adding.trim())}
              disabled={busy || !adding.trim()}
            >
              Добавить
            </button>
          </div>
        </div>

        {configs.map((c, ci) => (
          <details className="krsps-msg" key={c.id}>
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
                  setConfigs(configs.filter((_, j) => j !== ci));
                }}
              >
                <IconClose />
              </button>
            </summary>
            <div className="krsps-msg__body">
              <div className="krsps-sub">Классы · приоритет над суперклассами</div>
              <RuleTable ci={ci} kind="classes" rules={c.classes} />
              <div className="krsps-sub">Суперклассы · правило для всей группы</div>
              <RuleTable ci={ci} kind="superclasses" rules={c.superclasses} />
            </div>
          </details>
        ))}
        {configs.length === 0 && (
          <div className="krsps-empty">
            Таблиц нет — шлюз берёт числа напрямую из нейросети
          </div>
        )}
      </div>

      {/* ── Раздел 2: байт камер ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Байт камер</div>
          <div className="krsps-panel__meta">вне конфигураций · бит на камеру</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-note" style={{ marginBottom: 14 }}>
            Камера занимает <b>один бит</b> в байте камер, а не номер целиком. Поэтому в одном кадре видно
            сразу несколько камер, поймавших обнаружение: бит поднят — эта камера обнаружила. Камеры не
            привязаны к конфигурациям: камера физическая, от модели не зависит.
          </div>

          <div className="krsps-bitline">
            {Array.from({ length: 8 }, (_, i) => {
              const bit = 8 - i;
              const cam = cameras.find((c) => c.bit === bit);
              return (
                <div key={bit} className={`krsps-bitbox${cam ? ' krsps-bitbox--set' : ''}`}>
                  <div className="krsps-bitbox__v">{bit}</div>
                  <div className="krsps-bitbox__n">бит</div>
                  <div className="krsps-bitbox__c">{cam ? cam.title || cam.key : 'свободен'}</div>
                </div>
              );
            })}
          </div>

          <div className="krsps-tbl krsps-tbl--cam">
            <div className="krsps-tbl__head">
              <div>camera_id</div>
              <div>Читаемое название</div>
              <div>Бит</div>
              <div />
            </div>
            {cameras.map((c, i) => (
              <div className="krsps-tbl__row" key={i}>
                <input
                  className="krsps-input krsps-input--sm"
                  value={c.key}
                  spellCheck={false}
                  placeholder="camera_1"
                  onChange={(e) => {
                    const next = cameras.slice();
                    next[i] = { ...next[i], key: e.target.value };
                    setCameras(next);
                  }}
                />
                <input
                  className="krsps-input krsps-input--sm"
                  value={c.title}
                  placeholder="Камера контроля пути"
                  onChange={(e) => {
                    const next = cameras.slice();
                    next[i] = { ...next[i], title: e.target.value };
                    setCameras(next);
                  }}
                />
                <select
                  className="krsps-input krsps-input--sm"
                  value={c.bit}
                  onChange={(e) => {
                    const next = cameras.slice();
                    next[i] = { ...next[i], bit: Number(e.target.value) };
                    setCameras(next);
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
                  title="Удалить камеру"
                  onClick={() => setCameras(cameras.filter((_, j) => j !== i))}
                >
                  <IconClose />
                </button>
              </div>
            ))}
            {cameras.length === 0 && <div className="krsps-empty">Камер пока нет</div>}
          </div>
          <button
            type="button"
            className="krsps-btn krsps-btn--ghost"
            onClick={() => {
              // Подставляем первый свободный бит: занятый пришлось бы искать
              // глазами, а два бита на камеру шлюз не примет.
              const used = new Set(cameras.map((c) => c.bit));
              const free8 = Array.from({ length: 8 }, (_, i) => i + 1).find((b) => !used.has(b)) ?? 1;
              setCameras([...cameras, { key: '', title: '', bit: free8 }]);
            }}
            disabled={cameras.length >= 8}
          >
            {cameras.length >= 8 ? 'Все восемь бит заняты' : 'Добавить камеру'}
          </button>
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__body">
          {error && <div className="krsps-field__hint krsps-field__hint--error">{error}</div>}
          <div className="krsps-actions">
            <button type="button" className="krsps-btn krsps-btn--primary" onClick={handleSave} disabled={busy}>
              Сохранить таблицу
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaxonomyPanel;
