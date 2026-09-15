import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Select } from '../../../../app/Select';
import type { SelectOption } from '../../../../app/Select';
import { useToast } from '../../../birdview/components/common/Toast';
import { neuralApi } from '../../api/client';
import type { ConfigSummary } from '../../api/types';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import { useClassResolver } from './useClassResolver';
import { useCameraNames } from './useCameraNames';
import { DetectionRow } from './DetectionRow';
import { FrameWithBoxes } from './FrameWithBoxes';
import { ClassPicker, PresetSeg, VERDICT_OPTIONS } from './Filters';
import { FilterFields, classLabel, useJournalFilters } from './JournalFilters';
import { ExportModal } from './ExportModal';
import { JournalMap } from './JournalMap';
import { FrameViewer } from './FrameViewer';
import { StorageModal } from './StorageModal';
import { fmtCoord, fmtDateTime } from './format';
import './journal.css';

const PAGE_LIMIT = 300;
// Потолок ручки списка на сервере
const MAP_LIMIT_MAX = 10_000;
// Интервал опроса лёгкой ручки head. Полный список тянем только при изменении.
const POLL_MS = 2000;
const SKELETON_ROWS = 8;

const ALL_OPTION: SelectOption = { value: '', label: 'все' };

export function JournalSection() {
  const toast = useToast();
  // Журнал открывается за сегодня — свежие записи нужны чаще, чем весь архив.
  const fh = useJournalFilters();
  const { state: fs, filters, patch, applyPreset, selectConfig } = fh;
  const { verdict, cids, cameraId, configId } = fs;
  // классы фильтра — из выбранной конфигурации
  const { resolve, classOptions, optionsFor, legendFor } = useClassResolver(configId || undefined);
  const { cameraName, cameras } = useCameraNames();
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);

  const [dets, setDets] = useState<JournalDetection[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewerId, setViewerId] = useState<number | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [storageOpen, setStorageOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Поповер классов на панели карты: якорь — кнопка поля
  const [classOpen, setClassOpen] = useState(false);
  const classPaneRef = useRef<HTMLButtonElement>(null);

  // Ползунок полноэкранной карты: сколько записей грузить для точек.
  // draft двигается вместе с ручкой, запрос уходит по отпусканию.
  const [mapLimit, setMapLimit] = useState(PAGE_LIMIT);
  const [mapLimitDraft, setMapLimitDraft] = useState(PAGE_LIMIT);
  const [mapDets, setMapDets] = useState<JournalDetection[] | null>(null);
  const [mapLoading, setMapLoading] = useState(false);

  // Заметка и вердикт выбранной записи
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    neuralApi
      .listConfigurations()
      .then((res) => {
        if (alive) setConfigs(res.configurations);
      })
      .catch(() => {
        /* список конфигураций останется пустым */
      });
    return () => {
      alive = false;
    };
  }, []);

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
  const mapList = mapDets ?? dets;
  const withGps = useMemo(() => mapList.filter((d) => d.gps), [mapList]);

  useEffect(() => setNote(selectedDet?.verdict_note ?? ''), [selectedDet?.id, selectedDet?.verdict_note]);

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

  // Повторное нажатие той же кнопки снимает отметку — возврат в «не проверено».
  const setDetVerdict = async (det: JournalDetection, verdict: Verdict) => {
    const next: Verdict = det.verdict === verdict ? 'unverified' : verdict;
    setBusy(true);
    try {
      await journalApi.setVerdict(det.id, next, det.verdict_note ?? undefined);
      patchDet({ ...det, verdict: next, verdict_at: Date.now() });
    } catch (e) {
      toast('Вердикт не сохранён', e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async (det: JournalDetection) => {
    const value = note.trim();
    if (value === (det.verdict_note ?? '')) return;
    setBusy(true);
    try {
      await journalApi.setVerdict(det.id, det.verdict, value || undefined);
      patchDet({ ...det, verdict_note: value || null });
    } catch (e) {
      toast('Заметка не сохранена', e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const cameraOptions = useMemo<SelectOption[]>(
    () => [ALL_OPTION, ...cameras.map((c) => ({ value: c.id, label: c.name, hint: c.name !== c.id ? c.id : undefined }))],
    [cameras],
  );
  const configOptions = useMemo<SelectOption[]>(
    () => [ALL_OPTION, ...configs.map((c) => ({ value: c.id, label: c.name, hint: c.name !== c.id ? c.id : undefined }))],
    [configs],
  );

  const classesText = classLabel(fs, classOptions);

  const mapMax = Math.max(PAGE_LIMIT, Math.min(total, MAP_LIMIT_MAX));
  const mapValue = Math.min(mapLimitDraft, mapMax);
  const mapPct = mapMax > PAGE_LIMIT ? ((mapValue - PAGE_LIMIT) / (mapMax - PAGE_LIMIT)) * 100 : 0;

  const verdictCounts = useMemo(() => {
    const c = { true: 0, false: 0, unverified: 0 };
    for (const d of withGps) c[d.verdict] += 1;
    return c;
  }, [withGps]);

  const classPopover = (anchor: HTMLElement | null) =>
    classOpen &&
    anchor && (
      <ClassPicker
        anchor={anchor}
        options={classOptions}
        selected={cids}
        onChange={(next) => patch({ cids: next })}
        onClose={() => setClassOpen(false)}
      />
    );

  const fullMap = (
    <div className="j-full">
      <JournalMap
        detections={withGps}
        selectedId={selectedId}
        mode="full"
        resolve={resolve}
        cameraName={cameraName}
        onSelect={setSelectedId}
        onOpenViewer={setViewerId}
      />
      <div className="pane">
        <div className="blk-h">
          <h3>Фильтры</h3>
          <span className="tag is-acc spacer">{withGps.length} точек</span>
        </div>
        <div className="blk-b">
          <PresetSeg preset={fs.preset} onPreset={applyPreset} />
          <div className="tf-row">
            <div className="tf">
              <span className="tf-cap">Камера</span>
              <Select value={cameraId} options={cameraOptions} onChange={(v) => patch({ cameraId: v })} />
            </div>
            <div className="tf">
              <span className="tf-cap">Конфигурация</span>
              <Select value={configId} options={configOptions} onChange={selectConfig} />
            </div>
          </div>
          <div className="tf-row">
            <div className="tf">
              <span className="tf-cap">Классы</span>
              <button type="button" className="sel" ref={classPaneRef} onClick={() => setClassOpen((v) => !v)}>
                {classesText}
              </button>
            </div>
            <div className="tf">
              <span className="tf-cap">Вердикт</span>
              <Select
                value={verdict ?? ''}
                options={VERDICT_OPTIONS}
                onChange={(v) => patch({ verdict: v ? (v as Verdict) : undefined })}
              />
            </div>
          </div>
          {total > PAGE_LIMIT && (
            <div className="rngl">
              <span className="cap">
                Записей точками
                <b>
                  {mapValue} из {total}
                  {mapLoading ? ' …' : ''}
                </b>
              </span>
              <div className="tf-range">
                <div className="track">
                  <i style={{ width: `${mapPct}%` }} />
                  <b style={{ left: `${mapPct}%` }} />
                  <input
                    type="range"
                    min={PAGE_LIMIT}
                    max={mapMax}
                    step={1}
                    value={mapValue}
                    onChange={(e) => setMapLimitDraft(Number(e.target.value))}
                    onPointerUp={() => setMapLimit(mapLimitDraft)}
                    onKeyUp={(e) => {
                      if (e.key.startsWith('Arrow')) setMapLimit(mapLimitDraft);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <button className="icon-btn close" data-tip="Свернуть карту" onClick={() => setFullscreen(false)}>
        <Icon name="unfull" size={15} />
      </button>
      <div className="cnt">
        <span className="tag is-ok">подтверждённые {verdictCounts.true}</span>
        <span className="tag is-err">ложные {verdictCounts.false}</span>
        <span className="tag">не проверено {verdictCounts.unverified}</span>
        <span className="tag is-warn">без координат {mapList.length - withGps.length}</span>
      </div>
      {classPopover(classPaneRef.current)}
    </div>
  );

  const side = selectedDet ? (
    <>
      {/* Кадр сам открывает просмотрщик — отдельная кнопка на нём лишняя */}
      <button type="button" className="j-frame" title="Открыть кадр целиком" onClick={() => setViewerId(selectedDet.id)}>
        <FrameWithBoxes det={selectedDet} resolve={resolve} />
      </button>
      <div className="j-map">
        <JournalMap
          detections={selectedDet.gps ? [selectedDet] : []}
          selectedId={selectedId}
          mode="single"
          resolve={resolve}
          cameraName={cameraName}
          onSelect={setSelectedId}
          onOpenViewer={setViewerId}
        />
        {!selectedDet.gps && <div className="j-map-none">Нет координат</div>}
      </div>
      <div className="j-det">
        <div>
          <span className="eyebrow">Запись {selectedDet.id}</span>
          <div className="kv"><span className="k">Время</span><span className="v">{fmtDateTime(selectedDet.ts)}</span></div>
          <div className="kv"><span className="k">Камера</span><span className="v">{cameraName(selectedDet.camera_id)}</span></div>
          <div className="kv"><span className="k">Конфигурация</span><span className="v">{selectedDet.config_id ?? '—'}</span></div>
          <div className="kv">
            <span className="k">Координаты</span>
            <span className="v">
              {selectedDet.gps ? `${fmtCoord(selectedDet.gps.lat)}, ${fmtCoord(selectedDet.gps.lon)}` : '—'}
            </span>
          </div>
          <div className="kv"><span className="k">Объекты</span><span className="v">{selectedDet.objects.length}</span></div>
          {selectedDet.gps && (
            <>
              <div className="kv"><span className="k">Скорость</span><span className="v">{(selectedDet.gps.speed * 3.6).toFixed(1)} км/ч</span></div>
              <div className="kv"><span className="k">Курс</span><span className="v">{selectedDet.gps.course.toFixed(1)}°</span></div>
              <div className="kv"><span className="k">Высота</span><span className="v">{Math.round(selectedDet.gps.alt)} м</span></div>
            </>
          )}
        </div>
        <div className="j-verd">
          <button
            className={`btn btn--ok${selectedDet.verdict === 'true' ? ' is-on' : ''}`}
            disabled={busy}
            onClick={() => void setDetVerdict(selectedDet, 'true')}
          >
            Подтвердить
          </button>
          <button
            className={`btn btn--err${selectedDet.verdict === 'false' ? ' is-on' : ''}`}
            disabled={busy}
            onClick={() => void setDetVerdict(selectedDet, 'false')}
          >
            Ложное
          </button>
        </div>
        <div className="tf">
          <span className="tf-cap">Заметка</span>
          <input
            className="tf-in"
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => void saveNote(selectedDet)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </div>
      </div>
    </>
  ) : (
    <div className="empty">
      <Icon name="empty" className="ico" />
      <b>Запись не выбрана</b>
    </div>
  );

  const main = (
    <>
      <div className="filters">
        <FilterFields f={fh} cameraOptions={cameraOptions} configOptions={configOptions} classOptions={classOptions} />
        <div className="j-fright">
          <span className="fld j-found">
            <span className="k">Найдено</span>
            <span className="v">{total}</span>
          </span>
          <button className="icon-btn" data-tip="Скачать обнаружения" disabled={total === 0} onClick={() => setExportOpen(true)}>
            <Icon name="down" size={15} />
          </button>
          <button className="icon-btn" data-tip="Хранилище журнала" onClick={() => setStorageOpen(true)}>
            <Icon name="box" size={15} />
          </button>
          <button className="icon-btn" data-tip="Карта обнаружений" onClick={() => setFullscreen(true)}>
            <Icon name="map" size={15} />
          </button>
        </div>
      </div>

      <div className="nv">
        <div className="j-list">
          <div className="j-head">
            <span>Время</span>
            <span>Камера</span>
            <span>Объекты</span>
            <span>Координаты</span>
            <span>Вердикт</span>
          </div>
          <div className="j-rows" ref={listRef}>
            {newCount > 0 && (
              <button className="j-new" onClick={() => load(false)}>
                <Icon name="chev" size={12} className="ico" />
                {newCount} новых — показать
              </button>
            )}
            {loading && dets.length === 0 ? (
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <div className="j-row is-skel" key={i}>
                  <span className="skel" />
                  <span className="skel" />
                  <span className="skel" />
                  <span className="skel" />
                  <span className="skel" />
                </div>
              ))
            ) : err ? (
              <div className="empty">
                <Icon name="warn" className="ico" />
                <b>Журнал недоступен</b>
                <p>{err}</p>
              </div>
            ) : dets.length === 0 ? (
              <div className="empty">
                <Icon name="empty" className="ico" />
                <b>Записей нет</b>
              </div>
            ) : (
              dets.map((d) => (
                <DetectionRow
                  key={d.id}
                  det={d}
                  selected={d.id === selectedId}
                  resolve={resolve}
                  cameraName={cameraName}
                  onSelect={setSelectedId}
                />
              ))
            )}
          </div>
        </div>

        <aside className="j-side">{side}</aside>
      </div>
    </>
  );

  return (
    <div className="nv-journal">
      {fullscreen ? fullMap : main}

      {storageOpen && (
        <StorageModal onClose={() => setStorageOpen(false)} onPurged={() => load(true)} />
      )}

      {exportOpen && (
        <ExportModal
          initial={fs}
          cameraOptions={cameraOptions}
          configOptions={configOptions}
          optionsFor={optionsFor}
          legendFor={legendFor}
          resolve={resolve}
          cameraName={cameraName}
          onClose={() => setExportOpen(false)}
        />
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
