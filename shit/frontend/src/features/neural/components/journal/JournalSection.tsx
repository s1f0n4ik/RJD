import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalDetection, JournalFilters, Verdict } from '../../api/journal-types';
import { useClassResolver } from './useClassResolver';
import { useCameraNames } from './useCameraNames';
import { useImageBudget } from './useImageBudget';
import { DetectionRow } from './DetectionRow';
import { Filters, presetRange, DEFAULT_PRESET } from './Filters';
import type { PresetKey } from './Filters';
import { JournalMap } from './JournalMap';
import { FrameViewer } from './FrameViewer';
import { StorageModal } from './StorageModal';
import './journal.css';

// Ширина, с которой карта встаёт рядом со списком. Уже — одна колонка:
// фильтры сверху, список под ними, карта скрыта.
const WIDE_PX = 1000;
const PAGE_LIMIT = 300;
// Сколько изображений одновременно живёт в памяти. Записи (лёгкий JSON) грузим
// сотнями — от них зависят точки на карте, — а вот картинки держим по LRU:
// иначе после прокрутки в DOM осели бы все PAGE_LIMIT кадров.
const MAX_IMAGES = 50;
// Интервал опроса лёгкой ручки head. Полный список тянем только при изменении.
const POLL_MS = 2000;

const EMPTY_HINT =
  'Записи появляются по событиям трекера. Проверьте, что у конфигурации включён ' +
  'фильтр (трекер) и в маске событий потока отмечены нужные события.';

export function JournalSection() {
  const { resolve, classOptions } = useClassResolver();
  const cameraName = useCameraNames();
  const { allowed: allowedImages, request: requestImage } = useImageBudget(MAX_IMAGES);

  // Журнал открывается за сегодня — свежие записи нужны чаще, чем весь архив.
  const [preset, setPreset] = useState<PresetKey>(DEFAULT_PRESET);
  const [tFrom, setTFrom] = useState<number | undefined>(() => presetRange(DEFAULT_PRESET).from);
  const [tTo, setTTo] = useState<number | undefined>(() => presetRange(DEFAULT_PRESET).to);
  const [verdict, setVerdict] = useState<Verdict | undefined>();
  const [cids, setCids] = useState<number[]>([]);

  const [dets, setDets] = useState<JournalDetection[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewerId, setViewerId] = useState<number | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [storageOpen, setStorageOpen] = useState(false);

  // Ползунок полноэкранной карты: сколько записей грузить для точек.
  // draft двигается вместе с ручкой, запрос уходит по отпусканию.
  const [mapLimit, setMapLimit] = useState(PAGE_LIMIT);
  const [mapLimitDraft, setMapLimitDraft] = useState(PAGE_LIMIT);
  const [mapDets, setMapDets] = useState<JournalDetection[] | null>(null);
  const [mapLoading, setMapLoading] = useState(false);

  const [wide, setWide] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filters = useMemo<JournalFilters>(
    () => ({ tFrom, tTo, verdict, cids: cids.length ? cids : undefined }),
    [tFrom, tTo, verdict, cids],
  );

  const load = useCallback(
    (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      setErr(null);
      return journalApi
        .list(filters, { limit: PAGE_LIMIT, order: 'desc' })
        .then((res) => {
          setDets(res.detections);
          setTotal(res.total);
          setNewCount(0);
          setSelectedId((cur) =>
            cur != null && res.detections.some((d) => d.id === cur)
              ? cur
              : res.detections[0]?.id ?? null,
          );
        })
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [filters],
  );

  useEffect(() => {
    load(true);
  }, [load]);

  // Периодический опрос head: дёшево (пара чисел) и с теми же фильтрами, что и
  // список, поэтому счётчик новых записей честный. На скрытой вкладке молчим.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive || document.visibilityState !== 'visible') return;
      try {
        const h = await journalApi.head(filters);
        if (!alive) return;
        const shownMax = dets.length ? dets[0].id : 0;
        if (h.max_id <= shownMax) return;

        // Список прокручен вверх — обновляем молча, иначе показываем плашку,
        // чтобы содержимое не поехало под курсором во время разбора.
        const atTop = (listRef.current?.scrollTop ?? 0) < 40;
        if (atTop && viewerId == null) load(false);
        else setNewCount(Math.max(1, h.total - total));
      } catch {
        /* сеть моргнула — просто ждём следующего тика */
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [filters, dets, total, load, viewerId]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWide(entries[0].contentRect.width >= WIDE_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Расширенная выборка для карты — снимок; в пределах базового лимита карта
  // живёт от общего списка и обновляется поллингом.
  useEffect(() => {
    if (!fullscreen || mapLimit <= PAGE_LIMIT) {
      setMapDets(null);
      return;
    }
    let alive = true;
    setMapLoading(true);
    journalApi
      .list(filters, { limit: mapLimit, order: 'desc' })
      .then((res) => {
        if (alive) setMapDets(res.detections);
      })
      .catch(() => {
        /* карта останется на основной выборке */
      })
      .finally(() => {
        if (alive) setMapLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [fullscreen, mapLimit, filters]);

  const selectedDet = useMemo(() => dets.find((d) => d.id === selectedId) ?? null, [dets, selectedId]);
  const withGps = useMemo(() => (mapDets ?? dets).filter((d) => d.gps), [mapDets, dets]);

  // Запись из расширенной выборки карты может отсутствовать в основном
  // списке — просмотр листает тот массив, где запись нашлась.
  const viewerList = useMemo(
    () => (viewerId != null && !dets.some((d) => d.id === viewerId) ? mapDets ?? dets : dets),
    [dets, mapDets, viewerId],
  );
  const viewerIndex = useMemo(
    () => (viewerId == null ? -1 : viewerList.findIndex((d) => d.id === viewerId)),
    [viewerList, viewerId],
  );

  const patchDet = useCallback((updated: JournalDetection) => {
    setDets((list) => list.map((d) => (d.id === updated.id ? updated : d)));
    setMapDets((list) => (list ? list.map((d) => (d.id === updated.id ? updated : d)) : list));
  }, []);

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
        <button
          className="jr-icon-btn"
          onClick={() => setStorageOpen(true)}
          title="Хранилище журнала: лимиты и очистка"
          aria-label="Хранилище журнала"
        >
          ⚙
        </button>
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

  const listPanel = (
    <div className="jr-panel jr-list-col">
      <div className="jr-panel-head">
        <span className="jr-sect-lbl">Обнаружения</span>
        <span className="jr-count">{total}</span>
        {/* В узком режиме карты рядом нет — даём выход в полноэкранную. */}
        {!wide && (
          <button
            className="jr-icon-btn"
            onClick={() => setFullscreen(true)}
            title="Открыть карту со всеми обнаружениями"
            aria-label="Открыть карту со всеми обнаружениями"
          >
            ⤢
          </button>
        )}
      </div>

      {newCount > 0 && (
        <button className="jr-new-badge" onClick={() => load(false)}>
          ↑ {newCount} новых — показать
        </button>
      )}

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
        <div className="jr-list" ref={listRef}>
          {dets.map((d) => (
            <DetectionRow
              key={d.id}
              det={d}
              selected={d.id === selectedId}
              narrow={!wide}
              resolve={resolve}
              cameraName={cameraName}
              imageAllowed={allowedImages.has(d.id)}
              onSelect={setSelectedId}
              onChange={patchDet}
              onOpenViewer={setViewerId}
              onImageVisible={requestImage}
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
          cameraName={cameraName}
          onSelect={setSelectedId}
          onOpenViewer={setViewerId}
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
            cameraName={cameraName}
            onSelect={setSelectedId}
            onOpenViewer={setViewerId}
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
            {total > PAGE_LIMIT && (
              <div className="jr-fs-slider" title="Сколько последних записей показывать точками">
                <input
                  type="range"
                  min={PAGE_LIMIT}
                  max={Math.max(PAGE_LIMIT, total)}
                  step={1}
                  value={Math.min(mapLimitDraft, Math.max(PAGE_LIMIT, total))}
                  onChange={(e) => setMapLimitDraft(Number(e.target.value))}
                  onPointerUp={() => setMapLimit(mapLimitDraft)}
                  onKeyUp={(e) => {
                    if (e.key.startsWith('Arrow')) setMapLimit(mapLimitDraft);
                  }}
                />
                <span className="jr-fs-slider-val">
                  {mapLimitDraft}
                  {mapLoading ? ' ⋯' : ''}
                </span>
              </div>
            )}
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

      {storageOpen && (
        <StorageModal onClose={() => setStorageOpen(false)} onPurged={() => load(true)} />
      )}

      {viewerIndex >= 0 && (
        <FrameViewer
          det={viewerList[viewerIndex]}
          resolve={resolve}
          cameraName={cameraName}
          hasPrev={viewerIndex > 0}
          hasNext={viewerIndex < viewerList.length - 1}
          onPrev={() => setViewerId(viewerList[viewerIndex - 1]?.id ?? null)}
          onNext={() => setViewerId(viewerList[viewerIndex + 1]?.id ?? null)}
          onClose={() => setViewerId(null)}
          onChange={patchDet}
        />
      )}
    </div>
  );
}

export default JournalSection;
