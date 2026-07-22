import { memo, useEffect, useRef, useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { FrameWithBoxes } from './FrameWithBoxes';
import { JournalMap } from './JournalMap';
import { fmtCoord, fmtTime, pluralObjects } from './format';

const VERDICT_LABEL: Record<Verdict, string> = {
  unverified: 'не пров.',
  true: 'верно',
  false: 'ложное',
};

interface Props {
  det: JournalDetection;
  selected: boolean;
  /** Узкий режим: координаты кликабельны и раскрывают карту прямо в строке. */
  narrow: boolean;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  cameraName: (id: string) => string;
  /** Разрешено ли держать изображение смонтированным (LRU-бюджет журнала). */
  imageAllowed: boolean;
  onSelect: (id: number) => void;
  onChange: (updated: JournalDetection) => void;
  onOpenViewer: (id: number) => void;
  /** Строка попала в зону видимости — просим бюджет оставить её картинку. */
  onImageVisible: (id: number) => void;
}

function DetectionRowInner({
  det,
  selected,
  narrow,
  resolve,
  cameraName,
  imageAllowed,
  onSelect,
  onChange,
  onOpenViewer,
  onImageVisible,
}: Props) {
  const rowRef = useRef<HTMLDivElement>(null);

  // Картинку монтируем только когда строка близка к экрану: иначе после
  // прокрутки в памяти осели бы изображения всех загруженных записей.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onImageVisible(det.id);
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [det.id, onImageVisible]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(det.verdict_note ?? '');
  const [mapOpen, setMapOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setNote(det.verdict_note ?? ''), [det.id, det.verdict_note]);

  // Карта в строке живёт только в узком режиме — в широком она есть справа.
  useEffect(() => {
    if (!narrow) setMapOpen(false);
  }, [narrow]);

  // Классы кадра со счётчиком объектов: в списке важнее «сколько чего попало
  // в кадр», чем confidence отдельного объекта.
  const classAgg = new Map<number, ClassMeaning & { count: number }>();
  for (const o of det.objects) {
    const prev = classAgg.get(o.cid);
    if (prev) prev.count += 1;
    else classAgg.set(o.cid, { ...resolve(det.config_id, o.cid), count: 1 });
  }
  const classList = [...classAgg.values()].sort((a, b) => b.count - a.count);
  // Полный список показываем у выбранной записи — отдельная кнопка не нужна.
  const shownClasses = selected ? classList : classList.slice(0, 2);
  const hiddenCount = classList.length - shownClasses.length;
  const totalObjects = det.objects.length;

  // Повторное нажатие той же кнопки снимает отметку — возврат в «не проверено».
  const setVerdict = async (verdict: Verdict, e: React.MouseEvent) => {
    e.stopPropagation();
    const next: Verdict = det.verdict === verdict ? 'unverified' : verdict;
    setBusy(true);
    try {
      await journalApi.setVerdict(det.id, next, det.verdict_note ?? undefined);
      onChange({ ...det, verdict: next, verdict_at: Date.now() });
    } catch {
      /* вердикт просто не применится */
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    setBusy(true);
    try {
      await journalApi.setVerdict(det.id, det.verdict, note || undefined);
      onChange({ ...det, verdict_note: note || null });
      setNoteOpen(false);
    } catch {
      /* заметка не сохранится */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rowRef}
      className={`jr-row${selected ? ' sel' : ''}`}
      onClick={() => onSelect(det.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(det.id);
        }
      }}
    >
      <div className="jr-row-main">
        {/* Столбец 1: кадр и под ним камера */}
        <div className="jr-col-media">
          <button
            className="jr-thumb-btn"
            title="Открыть кадр"
            aria-label="Открыть кадр"
            onClick={(e) => {
              e.stopPropagation();
              onOpenViewer(det.id);
            }}
          >
            <FrameWithBoxes
              det={det}
              resolve={resolve}
              compact
              showImage={imageAllowed}
              className="jr-thumb"
            />
          </button>
          <span className="jr-cam-under">{cameraName(det.camera_id)}</span>
        </div>

        {/* Столбец 2: строки с информацией */}
        <div className="jr-col-info">
          {/* Строка 1: время слева, координаты справа */}
          <div className="jr-line-time">
            <span className="jr-time">{fmtTime(det.ts)}</span>
            {det.gps ? (
              narrow ? (
                <button
                  className={`jr-gps jr-gps-btn${mapOpen ? ' on' : ''}`}
                  title={mapOpen ? 'Скрыть карту' : 'Показать на карте'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(det.id);
                    setMapOpen((v) => !v);
                  }}
                >
                  ◎ {fmtCoord(det.gps.lat)}, {fmtCoord(det.gps.lon)}
                </button>
              ) : (
                <span className="jr-gps">
                  {fmtCoord(det.gps.lat)}, {fmtCoord(det.gps.lon)}
                </span>
              )
            ) : (
              <span className="jr-gps jr-nogps">без координат</span>
            )}
          </div>

          <div className="jr-chips">
            {shownClasses.map((c, i) => (
              <span className="jr-chip" key={i}>
                <span className="jr-cd" style={{ background: c.color }} />
                {c.name || '—'}
                <span className="jr-chip-n">×{c.count}</span>
              </span>
            ))}
            {hiddenCount > 0 && (
              <span className="jr-chip more" title="Выберите запись, чтобы увидеть все классы">
                +{hiddenCount}
              </span>
            )}
            {classList.length > 2 && (
              <span className="jr-objects-total">{pluralObjects(totalObjects)}</span>
            )}
          </div>

          <div className="jr-line-verdict">
            <span className={`jr-verdict ${det.verdict}`}>
              <span className="jr-d" />
              {VERDICT_LABEL[det.verdict]}
            </span>
            <div className="jr-row-actions">
              <button
                className={`jr-mini ok${det.verdict === 'true' ? ' on' : ''}`}
                disabled={busy}
                title="Отметить как верное"
                aria-label="Отметить как верное"
                onClick={(e) => setVerdict('true', e)}
              >
                ✓
              </button>
              <button
                className={`jr-mini err${det.verdict === 'false' ? ' on' : ''}`}
                disabled={busy}
                title="Отметить как ложное срабатывание"
                aria-label="Отметить как ложное срабатывание"
                onClick={(e) => setVerdict('false', e)}
              >
                ✗
              </button>
              {/* Заметка спрятана за кнопкой и только у выбранной записи. */}
              {selected && (
                <div className="jr-note-wrap">
                  <button
                    className={`jr-mini note${det.verdict_note ? ' on' : ''}`}
                    disabled={busy}
                    title={det.verdict_note ? 'Изменить заметку' : 'Добавить заметку'}
                    aria-label="Заметка"
                    onClick={(e) => {
                      e.stopPropagation();
                      setNoteOpen((v) => !v);
                    }}
                  >
                    ✎
                  </button>
                  {noteOpen && (
                    <>
                      <div
                        className="jr-class-backdrop"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNoteOpen(false);
                        }}
                      />
                      <div className="jr-note-form" onClick={(e) => e.stopPropagation()}>
                        <span className="jr-sect-lbl">Заметка о правдивости</span>
                        <textarea
                          className="jr-note-area"
                          value={note}
                          autoFocus
                          placeholder="Почему обнаружение верное или ложное…"
                          onChange={(e) => setNote(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote();
                            if (e.key === 'Escape') setNoteOpen(false);
                          }}
                        />
                        <div className="jr-note-actions">
                          <button className="jr-cal-reset" onClick={() => setNoteOpen(false)}>
                            Отмена
                          </button>
                          <button className="jr-cal-apply" disabled={busy} onClick={saveNote}>
                            Сохранить
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Карта под остальной информацией — только в узком режиме. */}
      {narrow && mapOpen && det.gps && (
        <div className="jr-row-map" onClick={(e) => e.stopPropagation()}>
          <JournalMap
            detections={[det]}
            selectedId={det.id}
            mode="single"
            resolve={resolve}
            onSelect={onSelect}
          />
        </div>
      )}
    </div>
  );
}

// Список длинный, а бюджет изображений меняет состояние при прокрутке —
// без мемоизации каждая такая смена перерисовывала бы все строки.
export const DetectionRow = memo(DetectionRowInner);
