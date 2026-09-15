import { useCallback, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Select } from '../../../../app/Select';
import type { SelectOption } from '../../../../app/Select';
import type { JournalFilters, Verdict } from '../../api/journal-types';
import { ClassPicker, DEFAULT_PRESET, PRESETS, PresetSeg, VERDICT_OPTIONS, presetRange } from './Filters';
import type { PresetKey } from './Filters';
import { DateRangePicker } from './DateRangePicker';
import type { ClassOption } from './useClassResolver';
import { fmtDate } from './format';

/** Состояние фильтров журнала: одно и то же у списка и у модалки выгрузки. */
export interface FilterState {
  preset: PresetKey;
  tFrom?: number;
  tTo?: number;
  verdict?: Verdict;
  cids: number[];
  cameraId: string;
  configId: string;
}

export function useJournalFilters(initial?: FilterState) {
  const [state, setState] = useState<FilterState>(
    () => initial ?? { preset: DEFAULT_PRESET, ...presetRange(DEFAULT_PRESET), cids: [], cameraId: '', configId: '' },
  );
  const patch = useCallback((p: Partial<FilterState>) => setState((s) => ({ ...s, ...p })), []);

  const applyPreset = useCallback((key: PresetKey) => {
    const r = presetRange(key);
    patch({ preset: key, tFrom: r.from, tTo: r.to });
  }, [patch]);

  const applyRange = useCallback((from?: number, to?: number) => {
    patch({ preset: from == null ? 'all' : 'custom', tFrom: from, tTo: to });
  }, [patch]);

  // Смена конфигурации сбрасывает классы: их набор зависит от неё
  const selectConfig = useCallback((configId: string) => patch({ configId, cids: [] }), [patch]);

  const filters = useMemo<JournalFilters>(
    () => ({
      tFrom: state.tFrom,
      tTo: state.tTo,
      verdict: state.verdict,
      cids: state.cids.length ? state.cids : undefined,
      cameraId: state.cameraId || undefined,
      configId: state.configId || undefined,
    }),
    [state],
  );

  return { state, patch, applyPreset, applyRange, selectConfig, filters };
}

export type JournalFilterHandle = ReturnType<typeof useJournalFilters>;

export const periodLabel = (s: FilterState) =>
  s.preset === 'custom' && s.tFrom != null
    ? `${fmtDate(s.tFrom)} — ${s.tTo != null ? fmtDate(s.tTo) : '…'}`
    : PRESETS.find((p) => p.key === s.preset)?.label.toLowerCase() ?? 'всё';

export const classLabel = (s: FilterState, options: ClassOption[]) =>
  `${s.cids.length ? s.cids.length : 'все'} из ${options.length}`;

interface FieldsProps {
  f: JournalFilterHandle;
  cameraOptions: SelectOption[];
  configOptions: SelectOption[];
  classOptions: ClassOption[];
  /** Поповеры поверх модалки */
  over?: boolean;
}

/** Пять полей фильтра с поповерами периода и классов. */
export function FilterFields({ f, cameraOptions, configOptions, classOptions, over }: FieldsProps) {
  const { state, patch, applyPreset, applyRange, selectConfig } = f;
  const [periodOpen, setPeriodOpen] = useState(false);
  const [classOpen, setClassOpen] = useState(false);
  const periodRef = useRef<HTMLButtonElement>(null);
  const classRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button type="button" className="fld fld--btn" ref={periodRef} onClick={() => setPeriodOpen((v) => !v)}>
        <span className="k">Период</span>
        <span className="v">{periodLabel(state)}</span>
        <Icon name="cal" className="ico" />
      </button>
      <div className="fld j-fld">
        <span className="k">Камера</span>
        <Select value={state.cameraId} options={cameraOptions} onChange={(cameraId) => patch({ cameraId })} />
      </div>
      <div className="fld j-fld">
        <span className="k">Конфигурация</span>
        <Select value={state.configId} options={configOptions} onChange={selectConfig} />
      </div>
      <button type="button" className="fld fld--btn" ref={classRef} onClick={() => setClassOpen((v) => !v)}>
        <span className="k">Классы</span>
        <span className="v">{classLabel(state, classOptions)}</span>
        <Icon name="chev" className="ico j-chev" />
      </button>
      <div className="fld j-fld">
        <span className="k">Вердикт</span>
        <Select
          value={state.verdict ?? ''}
          options={VERDICT_OPTIONS}
          onChange={(v) => patch({ verdict: v ? (v as Verdict) : undefined })}
        />
      </div>

      {periodOpen && periodRef.current && (
        <DateRangePicker
          anchor={periodRef.current}
          from={state.tFrom}
          to={state.tTo}
          over={over}
          onApply={applyRange}
          onClose={() => setPeriodOpen(false)}
          head={
            <PresetSeg
              preset={state.preset}
              onPreset={(key) => {
                applyPreset(key);
                setPeriodOpen(false);
              }}
            />
          }
        />
      )}
      {classOpen && classRef.current && (
        <ClassPicker
          anchor={classRef.current}
          options={classOptions}
          selected={state.cids}
          over={over}
          onChange={(cids) => patch({ cids })}
          onClose={() => setClassOpen(false)}
        />
      )}
    </>
  );
}
