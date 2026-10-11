import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from '../../../../app/Icons';
import { Select } from '../../../../app/Select';
import type { SelectOption } from '../../../../app/Select';
import { useToast } from '../../../birdview/components/common/Toast';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import { useClassResolver } from './useClassResolver';
import { useCameraNames } from './useCameraNames';
import { DetectionRow, detClass } from './DetectionRow';
import { FrameWithBoxes, useDetectionShots } from './FrameWithBoxes';
import { ClassPicker, PresetSeg, VERDICT_OPTIONS } from './Filters';
import { FilterFields, classLabel, useJournalFilters } from './JournalFilters';
import { ExportModal } from './ExportModal';
import { JournalMap } from './JournalMap';
import { JournalSummary } from './JournalSummary';
import { FrameViewer } from './FrameViewer';
import { StorageModal } from './StorageModal';
import { REASON_LABEL, durationLabel, fmtCoord, fmtDateTime } from './format';
import './journal.css';

const PAGE_LIMIT = 300;
// Потолок ручки списка на сервере
const MAP_LIMIT_MAX = 5000;
// Интервал опроса лёгкой ручки head. Полный список тянем только при изменении.
const POLL_MS = 2000;
const SKELETON_ROWS = 8;
// В поле «Треки» номеров не больше этого
const TRACKS_SHOWN = 5;

const ALL_OPTION: SelectOption = { value: '', label: 'все' };

export function JournalSection() {
  const toast = useToast();
  // С главной приходит обнаружение, которое надо выбрать
  const { state: routeState } = useLocation();
  const fh = useJournalFilters();
  const { state: fs, filters, patch, applyPreset, selectDevice } = fh;
  const { verdict, cids, deviceId, cameraId, configId } = fs;
  // классы фильтра — из выбранной конфигурации
  const { resolve, classOptions, optionsFor, legendFor, superOf, configs } = useClassResolver(configId || undefined);
  const { cameraName, deviceName, cameras, devices } = useCameraNames();

  const [dets, setDets] = useState<JournalDetection[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>((routeState as { open?: number } | null)?.open ?? null);
  const [fullscreen, setFullscreen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [viewer, setViewer] = useState<{ id: number; shot: number | null } | null>(null);
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

  // Заметка и вердикт выбранного обнаружения
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  // Число открытых по последнему опросу: его смена — закрытие обнаружения
  const openRef = useRef<number | null>(null);

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
    openRef.current = null;
    load(true);
  }, [load]);

  // Опрос head: новые обнаружения — плашкой или тихо сверху, закрытые — тихим перечитыванием
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive || document.visibilityState !== 'visible') return;
      try {
        const h = await journalApi.head(filters);
        if (!alive) return;
        const closed = openRef.current != null && h.open !== openRef.current;
        openRef.current = h.open;
        const shownMax = dets.length ? dets[0].id : 0;
        if (h.max_id > shownMax) {
          // Список прокручен — показываем плашку, чтобы строки не поехали под курсором
          const atTop = (listRef.current?.scrollTop ?? 0) < 40;
          if (atTop && viewer == null) load(false);
          else setNewCount(Math.max(1, h.total - total));
        } else if (closed) {
          load(false);
        }
      } catch {
        /* сеть моргнула — просто ждём следующего тика */
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [filters, dets, total, load, viewer]);

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
  const { shots, index: shotIndex, shot, tracks, setIndex: setShotIndex } = useDetectionShots(selectedDet);

  useEffect(() => setNote(selectedDet?.verdict_note ?? ''), [selectedDet?.id, selectedDet?.verdict_note]);

  // Обнаружение из расширенной выборки карты может отсутствовать в основном
  // списке — просмотр листает тот массив, где оно нашлось.
  const viewerId = viewer?.id ?? null;
  const viewerList = useMemo(
    () => (viewerId != null && !dets.some((d) => d.id === viewerId) ? mapDets ?? dets : dets),
    [dets, mapDets, viewerId],
  );
  const viewerIndex = useMemo(
    () => (viewerId == null ? -1 : viewerList.findIndex((d) => d.id === viewerId)),
    [viewerList, viewerId],
  );
  const openViewer = useCallback((id: number) => setViewer({ id, shot: null }), []);

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

  const deviceOptions = useMemo<SelectOption[]>(
    () => [ALL_OPTION, ...devices.map((d) => ({ value: d.id, label: d.name || d.id, hint: d.name ? d.id : undefined }))],
    [devices],
  );
  const cameraOptions = useMemo<SelectOption[]>(
    () => [
      ALL_OPTION,
      ...cameras
        .filter((c) => !deviceId || c.deviceId === deviceId)
        .map((c) => ({ value: c.id, label: c.name, hint: c.name !== c.id ? c.id : undefined })),
    ],
    [cameras, deviceId],
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
        onOpenViewer={openViewer}
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
              <span className="tf-cap">Устройство</span>
              <Select value={deviceId} options={deviceOptions} onChange={selectDevice} />
            </div>
            <div className="tf">
              <span className="tf-cap">Камера</span>
              <Select value={cameraId} options={cameraOptions} onChange={(v) => patch({ cameraId: v })} />
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
                Обнаружений точками
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

  const selClass = selectedDet ? detClass(selectedDet, resolve) : null;
  const trackText = tracks.length
    ? `${tracks.slice(0, TRACKS_SHOWN).map((t) => `#${t.track_no}`).join(', ')}${tracks.length > TRACKS_SHOWN ? ' …' : ''} (${tracks.length})`
    : String(selectedDet?.tracks ?? '—');

  const side = selectedDet && selClass ? (
    <>
      <div className="j-frame-wrap">
        <button
          type="button"
          className="j-frame"
          onClick={() => setViewer({ id: selectedDet.id, shot: shot?.image_id ?? null })}
        >
          <FrameWithBoxes shot={shot} color={selClass.color} name={selClass.name} />
        </button>
        {shots.length > 1 && (
          <>
            <button
              type="button"
              className="jr-nav l"
              data-tip="Предыдущий снимок"
              disabled={shotIndex === 0}
              onClick={() => setShotIndex(shotIndex - 1)}
            >
              <Icon name="chev" size={14} />
            </button>
            <button
              type="button"
              className="jr-nav r"
              data-tip="Следующий снимок"
              disabled={shotIndex === shots.length - 1}
              onClick={() => setShotIndex(shotIndex + 1)}
            >
              <Icon name="chev" size={14} />
            </button>
            <span className="jr-count num">{shotIndex + 1} / {shots.length}</span>
          </>
        )}
        <button
          className="icon-btn fs"
          data-tip="Открыть кадр целиком"
          onClick={() => setViewer({ id: selectedDet.id, shot: shot?.image_id ?? null })}
        >
          <Icon name="full" size={14} />
        </button>
      </div>
      <div className="j-map">
        <JournalMap
          detections={selectedDet.gps ? [selectedDet] : []}
          selectedId={selectedId}
          mode="single"
          resolve={resolve}
          cameraName={cameraName}
          onSelect={setSelectedId}
          onOpenViewer={openViewer}
        />
        {!selectedDet.gps && <div className="j-map-none">Нет координат</div>}
        <button className="icon-btn fs" data-tip="Карта на весь экран" onClick={() => setFullscreen(true)}>
          <Icon name="full" size={14} />
        </button>
      </div>
      <div className="j-det">
        <div>
          <span className="eyebrow">Обнаружение {selectedDet.id}</span>
          <div className="kv"><span className="k">Начало</span><span className="v">{fmtDateTime(selectedDet.started_at)}</span></div>
          <div className="kv"><span className="k">Длительность</span><span className="v">{durationLabel(selectedDet)}</span></div>
          <div className="kv"><span className="k">Устройство</span><span className="v">{deviceName(selectedDet.device_id)}</span></div>
          <div className="kv"><span className="k">Камера</span><span className="v">{cameraName(selectedDet.camera_id)}</span></div>
          <div className="kv"><span className="k">Конфигурация</span><span className="v">{selectedDet.config_id ?? '—'}</span></div>
          <div className="kv">
            <span className="k">Класс</span>
            <span className="v">
              <span className="seps">
                <span>{selClass.name}</span>
                {selClass.superName && <span>{selClass.superName}</span>}
              </span>
            </span>
          </div>
          <div className="kv"><span className="k">Треки</span><span className="v">{trackText}</span></div>
          <div className="kv">
            <span className="k">Закрыто</span>
            <span className="v">{selectedDet.closed_reason ? REASON_LABEL[selectedDet.closed_reason] ?? selectedDet.closed_reason : '—'}</span>
          </div>
          <div className="kv">
            <span className="k">Координаты</span>
            <span className="v">
              {selectedDet.gps ? `${fmtCoord(selectedDet.gps.lat)}, ${fmtCoord(selectedDet.gps.lon)}` : '—'}
            </span>
          </div>
          {selectedDet.gps?.speed != null && (
            <div className="kv"><span className="k">Скорость</span><span className="v">{(selectedDet.gps.speed * 3.6).toFixed(1)} км/ч</span></div>
          )}
          {selectedDet.gps?.course != null && (
            <div className="kv"><span className="k">Курс</span><span className="v">{selectedDet.gps.course.toFixed(1)}°</span></div>
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
      <b>Обнаружение не выбрано</b>
    </div>
  );

  const fields = (
    <FilterFields
      f={fh}
      deviceOptions={deviceOptions}
      cameraOptions={cameraOptions}
      configOptions={configOptions}
      classOptions={classOptions}
    />
  );

  const found = (
    <span className="fld j-found">
      <span className="k">Найдено</span>
      <span className="v">{total}</span>
    </span>
  );

  const summary = (
    <>
      <div className="filters">
        {fields}
        <div className="j-fright">
          {found}
          <button className="icon-btn" data-tip="Вернуться к журналу" onClick={() => setSummaryOpen(false)}>
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>
      <JournalSummary
        filters={filters}
        classOptions={optionsFor(configId || undefined)}
        superOf={superOf}
        cameraName={cameraName}
        deviceName={deviceName}
      />
    </>
  );

  const main = (
    <>
      <div className="filters">
        {fields}
        <div className="j-fright">
          {found}
          <button className="icon-btn" data-tip="Сводка за период" disabled={total === 0} onClick={() => setSummaryOpen(true)}>
            <Icon name="grid" size={15} />
          </button>
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
            <span>Начало</span>
            <span>Камера</span>
            <span>Класс</span>
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
                <b>Обнаружений нет</b>
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
      {fullscreen ? fullMap : summaryOpen ? summary : main}

      {storageOpen && (
        <StorageModal onClose={() => setStorageOpen(false)} onPurged={() => load(true)} />
      )}

      {exportOpen && (
        <ExportModal
          initial={fs}
          deviceOptions={deviceOptions}
          cameraOptions={cameraOptions}
          configOptions={configOptions}
          optionsFor={optionsFor}
          legendFor={legendFor}
          resolve={resolve}
          cameraName={cameraName}
          onClose={() => setExportOpen(false)}
        />
      )}

      {viewer && viewerIndex >= 0 && (
        <FrameViewer
          det={viewerList[viewerIndex]}
          initialShot={viewer.shot}
          resolve={resolve}
          cameraName={cameraName}
          hasPrev={viewerIndex > 0}
          hasNext={viewerIndex < viewerList.length - 1}
          onPrev={() => setViewer({ id: viewerList[viewerIndex - 1].id, shot: null })}
          onNext={() => setViewer({ id: viewerList[viewerIndex + 1].id, shot: null })}
          onClose={() => setViewer(null)}
          onChange={patchDet}
        />
      )}
    </div>
  );
}

export default JournalSection;
