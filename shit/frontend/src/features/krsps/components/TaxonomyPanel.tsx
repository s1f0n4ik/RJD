import React, { useEffect, useState } from 'react';
import { IconClose, IconTune } from '../icons';
import type { GwTaxonomy, GwTaxonomyCamera, GwTaxonomyPatch, GwTaxonomyRule } from '../types';

interface Props {
  taxonomy: GwTaxonomy | null;
  busy: boolean;
  onSave: (patch: GwTaxonomyPatch) => void;
}

// Таблица соответствий: имена, которыми оперирует нейросеть, против числовых id,
// которых требуют протоколы. Таблица одна на весь шлюз — её применяют все модули
// всех конфигураций, поэтому раздел лежит рядом с модулями, а не внутри одного.
//
// Приоритет: правило класса перекрывает правило суперкласса, причём только теми
// полями, которые в нём заданы. «Наследовать» в выпадающем списке — это 0, то
// есть «не задано»: значение придёт от суперкласса, а если и там нет — из
// значений по умолчанию.

const INHERIT = 0;

type RuleKind = 'classes' | 'superclasses';

const Select: React.FC<{
  value: number;
  items: Array<{ id: number; title: string }>;
  inheritLabel: string;
  onChange: (v: number) => void;
}> = ({ value, items, inheritLabel, onChange }) => (
  <select
    className="krsps-input krsps-input--sm"
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
  >
    <option value={INHERIT}>{inheritLabel}</option>
    {items.map((i) => (
      <option key={i.id} value={i.id}>
        {i.id} · {i.title}
      </option>
    ))}
  </select>
);

const TaxonomyPanel: React.FC<Props> = ({ taxonomy, busy, onSave }) => {
  const [classes, setClasses] = useState<GwTaxonomyRule[]>([]);
  const [supers, setSupers] = useState<GwTaxonomyRule[]>([]);
  const [cameras, setCameras] = useState<GwTaxonomyCamera[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!taxonomy) return;
    setClasses(taxonomy.classes);
    setSupers(taxonomy.superclasses);
    setCameras(taxonomy.cameras);
  }, [taxonomy]);

  if (!taxonomy) {
    return <div className="krsps-empty">Загрузка таблицы соответствий…</div>;
  }

  const rulesOf = (k: RuleKind) => (k === 'classes' ? classes : supers);
  const setRules = (k: RuleKind, v: GwTaxonomyRule[]) => (k === 'classes' ? setClasses(v) : setSupers(v));

  const patchRule = (k: RuleKind, i: number, patch: Partial<GwTaxonomyRule>) => {
    const next = rulesOf(k).slice();
    next[i] = { ...next[i], ...patch };
    setRules(k, next);
  };

  const addRule = (k: RuleKind) =>
    setRules(k, [...rulesOf(k), { key: '', title: '', type: INHERIT, danger: INHERIT }]);

  const removeRule = (k: RuleKind, i: number) =>
    setRules(k, rulesOf(k).filter((_, j) => j !== i));

  const handleSave = () => {
    const all = [...classes, ...supers];
    if (all.some((r) => !r.key.trim())) {
      setError('У каждого правила должно быть имя класса — по нему ищется соответствие.');
      return;
    }
    if (cameras.some((c) => !c.key.trim())) {
      setError('У каждой камеры должен быть camera_id.');
      return;
    }
    const dupe = (rs: Array<{ key: string }>) => {
      const seen = new Set<string>();
      return rs.find((r) => {
        const k = r.key.trim().toLowerCase();
        if (seen.has(k)) return true;
        seen.add(k);
        return false;
      });
    };
    // Дубликат ключа — это молча неработающее правило: сработает первое, а
    // второе будет висеть на странице и выглядеть настроенным.
    const d = dupe(classes) ?? dupe(supers) ?? dupe(cameras);
    if (d) {
      setError(`Имя «${d.key}» встречается дважды — оставьте одно правило.`);
      return;
    }
    setError('');
    onSave({ classes, superclasses: supers, cameras });
  };

  const RuleTable: React.FC<{ kind: RuleKind; rules: GwTaxonomyRule[] }> = ({ kind, rules }) => (
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
              onChange={(e) => patchRule(kind, i, { key: e.target.value })}
            />
            <input
              className="krsps-input krsps-input--sm"
              value={r.title}
              placeholder="Человек"
              onChange={(e) => patchRule(kind, i, { title: e.target.value })}
            />
            <Select
              value={r.type}
              items={taxonomy.types}
              inheritLabel={kind === 'classes' ? 'от суперкласса' : 'по умолчанию'}
              onChange={(v) => patchRule(kind, i, { type: v })}
            />
            <Select
              value={r.danger}
              items={taxonomy.dangers}
              inheritLabel={kind === 'classes' ? 'от суперкласса' : 'по умолчанию'}
              onChange={(v) => patchRule(kind, i, { danger: v })}
            />
            <button
              type="button"
              className="krsps-icon-btn"
              title="Удалить правило"
              onClick={() => removeRule(kind, i)}
            >
              <IconClose />
            </button>
          </div>
        ))}
        {rules.length === 0 && <div className="krsps-empty">Правил пока нет</div>}
      </div>
      <button type="button" className="krsps-btn krsps-btn--ghost" onClick={() => addRule(kind)}>
        Добавить правило
      </button>
    </>
  );

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
          <div className="krsps-clock__note">
            Нейросеть отдаёт имена: класс (<code>cls</code>) и суперкласс (<code>scls</code>). Протоколы
            требуют числа: тип обнаружения 1–8 и класс опасности 1–4. Здесь задаётся связь между ними —
            один раз на весь шлюз. <b>Правило класса перекрывает правило суперкласса</b>, но только теми
            полями, которые в нём заданы: можно уточнить классу лишь опасность, а тип оставить от группы.
            Если соответствия нет вообще, берутся значения по умолчанию (тип {taxonomy.defaults.type},
            опасность {taxonomy.defaults.danger}).
          </div>
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Классы</div>
          <div className="krsps-panel__meta">приоритет над суперклассами</div>
        </div>
        <div className="krsps-panel__body">
          <RuleTable kind="classes" rules={classes} />
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Суперклассы</div>
          <div className="krsps-panel__meta">правило для всей группы</div>
        </div>
        <div className="krsps-panel__body">
          <RuleTable kind="superclasses" rules={supers} />
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Камеры</div>
          <div className="krsps-panel__meta">camera_id от media-center → номер в протоколе</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-tbl krsps-tbl--cam">
            <div className="krsps-tbl__head">
              <div>camera_id</div>
              <div>Читаемое название</div>
              <div>Номер</div>
              <div />
            </div>
            {cameras.map((c, i) => (
              <div className="krsps-tbl__row" key={i}>
                <input
                  className="krsps-input krsps-input--sm"
                  value={c.key}
                  spellCheck={false}
                  onChange={(e) => {
                    const next = cameras.slice();
                    next[i] = { ...next[i], key: e.target.value };
                    setCameras(next);
                  }}
                />
                <input
                  className="krsps-input krsps-input--sm"
                  value={c.title}
                  onChange={(e) => {
                    const next = cameras.slice();
                    next[i] = { ...next[i], title: e.target.value };
                    setCameras(next);
                  }}
                />
                <select
                  className="krsps-input krsps-input--sm"
                  value={c.id}
                  onChange={(e) => {
                    const next = cameras.slice();
                    next[i] = { ...next[i], id: Number(e.target.value) };
                    setCameras(next);
                  }}
                >
                  <option value={1}>1 · контроль пути</option>
                  <option value={2}>2 · контроль рабочей зоны</option>
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
            onClick={() => setCameras([...cameras, { key: '', title: '', id: 1 }])}
          >
            Добавить камеру
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
