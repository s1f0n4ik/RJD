import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalDetection, JournalFilters, Verdict } from '../../api/journal-types';
import { useClassResolver } from './useClassResolver';
import { DetectionRow } from './DetectionRow';
import { Filters } from './Filters';
import { DetailPanel } from './DetailPanel';
import { JournalMap } from './JournalMap';
import './journal.css';

// Ширина, с которой рядом со списком появляется карта и фильтры. Уже — только
// список (карта и фильтры скрыты), как задумано для узкого экрана на борту.
const WIDE_PX = 1100;
const PAGE_LIMIT = 300;

export function JournalSection() {
  const { resolve, classOptions } = useClassResolver();

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

  // Загрузка списка при смене фильтров.
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

  // Отслеживание ширины контейнера для показа карты.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWide(entries[0].contentRect.width >= WIDE_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selectedDet = useMemo(() => dets.find((d) => d.id === selectedId) ?? null, [dets, selectedId]);

  const patchDet = useCallback((updated: JournalDetection) => {
    setDets((list) => list.map((d) => (d.id === updated.id ? updated : d)));
  }, []);

  const onTime = useCallback((from?: number, to?: number) => {
    setTFrom(from);
    setTTo(to);
  }, []);

  const list = (
    <div className="jr-list-col">
      <div className="jr-list-head">
        <span className="jr-sect-lbl">Обнаружения</span>
        <span className="jr-count">{total}</span>
      </div>
      {loading && dets.length === 0 ? (
        <div className="jr-empty">Загрузка…</div>
      ) : err ? (
        <div className="jr-err">{err}</div>
      ) : dets.length === 0 ? (
        <div className="jr-empty">Записей нет</div>
      ) : (
        <div className="jr-list">
          {dets.map((d) => (
            <DetectionRow
              key={d.id}
              det={d}
              selected={d.id === selectedId}
              resolve={resolve}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="jr-root" ref={rootRef}>
      {wide ? (
        <div className="jr-split">
          {list}
          <div className="jr-right-col">
            <Filters
              tFrom={tFrom}
              tTo={tTo}
              verdict={verdict}
              selectedCids={cids}
              classOptions={classOptions}
              onTime={onTime}
              onVerdict={setVerdict}
              onCids={setCids}
            />
            <div className="jr-map-wrap">
              <JournalMap
                detections={selectedDet ? [selectedDet] : []}
                selectedId={selectedId}
                mode="single"
                resolve={resolve}
                onSelect={setSelectedId}
              />
              <button className="jr-expand" onClick={() => setFullscreen(true)}>
                ⤢ на весь экран
              </button>
              {selectedDet && (
                <div className="jr-map-detail">
                  <DetailPanel det={selectedDet} resolve={resolve} onChange={patchDet} />
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        list
      )}

      {fullscreen && (
        <div className="jr-fs">
          <JournalMap
            detections={dets}
            selectedId={selectedId}
            mode="full"
            resolve={resolve}
            onSelect={setSelectedId}
          />
          <div className="jr-fs-filters">
            <div className="jr-fs-ttl">Фильтры</div>
            <Filters
              tFrom={tFrom}
              tTo={tTo}
              verdict={verdict}
              selectedCids={cids}
              classOptions={classOptions}
              onTime={onTime}
              onVerdict={setVerdict}
              onCids={setCids}
            />
            <div className="jr-fs-count">{total} обнаружений</div>
          </div>
          <button className="jr-fs-close" onClick={() => setFullscreen(false)}>
            ⤡ свернуть
          </button>
        </div>
      )}
    </div>
  );
}

export default JournalSection;
