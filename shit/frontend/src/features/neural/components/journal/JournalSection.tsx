import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalDetection, JournalFilters, Verdict } from '../../api/journal-types';
import { useClassResolver } from './useClassResolver';
import { DetectionRow } from './DetectionRow';
import { Filters, presetRange } from './Filters';
import type { PresetKey } from './Filters';
import { JournalMap } from './JournalMap';
import './journal.css';

// Ширина, с которой карта встаёт рядом со списком. Уже — одна колонка:
// фильтры сверху, список под ними, карта скрыта.
const WIDE_PX = 1000;
const PAGE_LIMIT = 300;

// Журнал наполняется по событиям трекера, поэтому пустой список — штатная
// ситуация, а не ошибка. Объясняем это прямо в интерфейсе.
const EMPTY_HINT =
  'Записи появляются по событиям трекера. Проверьте, что у конфигурации включён ' +
  'фильтр (трекер) и в маске событий потока отмечены нужные события.';

export function JournalSection() {
  const { resolve, classOptions } = useClassResolver();

  const [preset, setPreset] = useState<PresetKey>('all');
  const [tFrom, setTFrom] = useState<number | undefined>();
  const [tTo, setTTo] = useState<number | undefined>();
  const [verdict, setVerdict] = useState<Verdict | undefined>();
  const [cids, setCids] = useState<number[]>([]);

  const [dets, setDets] = useState<JournalDetection[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const [wide, setWide] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const filters = useMemo<JournalFilters>(
    () => ({ tFrom, tTo, verdict, cids: cids.length ? cids : undefined }),
    [tFrom, tTo, verdict, cids],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    journalApi
      .list(filters, { limit: PAGE_LIMIT, order: 'desc' })
      .then((res) => {
        if (!alive) return;
        setDets(res.detections);
        setTotal(res.total);
        setSelectedId((cur) =>
          cur != null && res.detections.some((d) => d.id === cur)
            ? cur
            : res.detections[0]?.id ?? null,
        );
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [filters]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWide(entries[0].contentRect.width >= WIDE_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selectedDet = useMemo(() => dets.find((d) => d.id === selectedId) ?? null, [dets, selectedId]);
  const withGps = useMemo(() => dets.filter((d) => d.gps), [dets]);

  const patchDet = useCallback((updated: JournalDetection) => {
    setDets((list) => list.map((d) => (d.id === updated.id ? updated : d)));
  }, []);

  // Пресет — основной способ: сам считает диапазон. Точный диапазон из
  // календаря переводит фильтр в режим «custom».
  const applyPreset = useCallback((key: PresetKey) => {
    setPreset(key);
    const r = presetRange(key);
    setTFrom(r.from);
    setTTo(r.to);
  }, []);

  const applyRange = useCallback((from?: number, to?: number) => {
    setPreset(from == null ? 'all' : 'custom');
    setTFrom(from);
    setTTo(to);
  }, []);

  const filtersPanel = (
    <div className="jr-panel jr-filters-panel">
      <div className="jr-panel-head">
        <span className="jr-sect-lbl">Фильтры</span>
      </div>
      <Filters
        preset={preset}
        tFrom={tFrom}
        tTo={tTo}
        verdict={verdict}
        selectedCids={cids}
        classOptions={classOptions}
        onPreset={applyPreset}
        onRange={applyRange}
        onVerdict={setVerdict}
        onCids={setCids}
      />
    </div>
  );

  // Список занимает всю доступную высоту и прокручивается внутри себя, чтобы
  // страница целиком не скроллилась.
  const listPanel = (
    <div className="jr-panel jr-list-col">
      <div className="jr-panel-head">
        <span className="jr-sect-lbl">Обнаружения</span>
        <span className="jr-count">{total}</span>
      </div>

      {loading && dets.length === 0 ? (
        <div className="jr-placeholder">
          <span className="jr-ph-icon">⋯</span>
          <div className="jr-ph-title">Загрузка</div>
        </div>
      ) : err ? (
        <div className="jr-placeholder">
          <span className="jr-ph-icon err">⚠</span>
          <div className="jr-ph-title err">Журнал недоступен</div>
          <div className="jr-ph-text">{err}</div>
        </div>
      ) : dets.length === 0 ? (
        <div className="jr-placeholder">
          <span className="jr-ph-icon">∅</span>
          <div className="jr-ph-title">Записей нет</div>
          <div className="jr-ph-text">{EMPTY_HINT}</div>
        </div>
      ) : (
        <div className="jr-list">
          {dets.map((d) => (
            <DetectionRow
              key={d.id}
              det={d}
              selected={d.id === selectedId}
              resolve={resolve}
              onSelect={setSelectedId}
              onChange={patchDet}
            />
          ))}
        </div>
      )}
    </div>
  );

  const mapPanel = (
    <div className="jr-panel jr-map-panel">
      <div className="jr-panel-head">
        <span className="jr-sect-lbl">Карта</span>
        <button
          className="jr-icon-btn"
          onClick={() => setFullscreen(true)}
          title="Открыть карту на весь экран"
          aria-label="Открыть карту на весь экран"
        >
          ⤢
        </button>
      </div>
      <div className="jr-map-wrap">
        <JournalMap
          detections={selectedDet && selectedDet.gps ? [selectedDet] : []}
          selectedId={selectedId}
          mode="single"
          resolve={resolve}
          onSelect={setSelectedId}
        />
        {!selectedDet?.gps && (
          <div className="jr-map-empty">
            {selectedDet ? 'У записи нет координат' : 'Нет точек с координатами'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className={`jr-root${wide ? ' wide' : ''}`} ref={rootRef}>
      {wide ? (
        <div className="jr-split">
          {listPanel}
          <div className="jr-right-col">
            {filtersPanel}
            {mapPanel}
          </div>
        </div>
      ) : (
        // Узкий экран: фильтры сверху, под ними список. Карты нет.
        <div className="jr-stack">
          {filtersPanel}
          {listPanel}
        </div>
      )}

      {fullscreen && (
        <div className="jr-fs">
          <JournalMap
            detections={withGps}
            selectedId={selectedId}
            mode="full"
            resolve={resolve}
            onSelect={setSelectedId}
          />
          <div className="jr-fs-filters">
            <div className="jr-sect-lbl">Фильтры</div>
            <Filters
              preset={preset}
              tFrom={tFrom}
              tTo={tTo}
              verdict={verdict}
              selectedCids={cids}
              classOptions={classOptions}
              onPreset={applyPreset}
              onRange={applyRange}
              onVerdict={setVerdict}
              onCids={setCids}
            />
            <div className="jr-fs-count">
              {withGps.length} из {total} с координатами
            </div>
          </div>
          <button
            className="jr-fs-close"
            onClick={() => setFullscreen(false)}
            title="Свернуть карту"
            aria-label="Свернуть карту"
          >
            ⤡
          </button>
          {withGps.length === 0 && (
            <div className="jr-fs-empty">Нет точек с координатами по текущим фильтрам</div>
          )}
        </div>
      )}
    </div>
  );
}

export default JournalSection;
