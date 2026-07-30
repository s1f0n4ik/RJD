import { useEffect, useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { fmtCoord, fmtDateTime } from './format';

interface Props {
  det: JournalDetection;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  cameraName: (id: string) => string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onChange: (updated: JournalDetection) => void;
}

/** Полноэкранный просмотр кадра: боксы поверх чистого изображения, мета и
 *  список объектов — сворачиваемыми панелями поверх кадра. */
export function FrameViewer({
  det,
  resolve,
  cameraName,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onChange,
}: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [metaOpen, setMetaOpen] = useState(true);
  const [objectsOpen, setObjectsOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  // Кадр мог быть удалён чистильщиком лимита изображений; листание сбрасывает
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [det.id]);

  // Esc закрывает, стрелки листают — просмотр рассчитан на разбор с клавиатуры.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      else if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  // Повторное нажатие той же кнопки снимает отметку — как и в списке.
  const setVerdict = async (verdict: Verdict) => {
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

  const w = det.width || 0;
  const h = det.height || 0;
  const canDraw = w > 0 && h > 0;

  return (
    <div className="jr-viewer">
      <button className="jr-viewer-close" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">
        ✕
      </button>

      <button
        className="jr-viewer-arrow left"
        onClick={onPrev}
        disabled={!hasPrev}
        title="Предыдущая запись (←)"
        aria-label="Предыдущая запись"
      >
        ‹
      </button>
      <button
        className="jr-viewer-arrow right"
        onClick={onNext}
        disabled={!hasNext}
        title="Следующая запись (→)"
        aria-label="Следующая запись"
      >
        ›
      </button>

      <div className="jr-viewer-stage">
        <div className="jr-viewer-frame">
          {missing ? (
            <div className="jr-viewer-missing">
              <span className="ico">▣</span>
              Изображение не найдено или было удалено
            </div>
          ) : (
            <img
              src={journalApi.frameUrl(det.id)}
              alt="Кадр обнаружения"
              onError={() => setMissing(true)}
            />
          )}

          {!missing &&
            canDraw &&
            det.objects.map((o, i) => {
              const m = resolve(det.config_id, o.cid);
              const color = m.color || m.superColor || '#4d8bff';
              return (
                <span
                  key={i}
                  className={`jr-vbox${o.state ? ' ' + o.state : ''}${hovered === i ? ' hot' : ''}`}
                  style={{
                    left: `${(o.box[0] / w) * 100}%`,
                    top: `${(o.box[1] / h) * 100}%`,
                    width: `${(o.box[2] / w) * 100}%`,
                    height: `${(o.box[3] / h) * 100}%`,
                    borderColor: color,
                  }}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <span className="jr-vbox-lbl" style={{ background: color }}>
                    {m.name || '—'} {o.cf.toFixed(2)}
                  </span>
                </span>
              );
            })}

          {/* Мета поверх кадра, справа сверху */}
          <div className={`jr-viewer-meta${metaOpen ? '' : ' closed'}`}>
            <button className="jr-viewer-panel-head" onClick={() => setMetaOpen((v) => !v)}>
              <span className="jr-sect-lbl">Данные кадра</span>
              <span className="jr-caret">{metaOpen ? '▴' : '▾'}</span>
            </button>
            {metaOpen && (
              <div className="jr-viewer-panel-body">
                <div className="jr-drow">
                  <span className="jr-kk">Камера</span>
                  <span className="jr-vv">{cameraName(det.camera_id)}</span>
                </div>
                <div className="jr-drow">
                  <span className="jr-kk">Время</span>
                  <span className="jr-vv">{fmtDateTime(det.ts)}</span>
                </div>
                <div className="jr-drow">
                  <span className="jr-kk">Unix</span>
                  <span className="jr-vv">{det.ts}</span>
                </div>
                <div className="jr-drow">
                  <span className="jr-kk">GPS</span>
                  <span className="jr-vv">
                    {det.gps ? `${fmtCoord(det.gps.lat)}, ${fmtCoord(det.gps.lon)}` : 'нет данных'}
                  </span>
                </div>
                {det.gps && (
                  <div className="jr-drow">
                    <span className="jr-kk">Скорость</span>
                    <span className="jr-vv">{det.gps.speed.toFixed(1)} м/с</span>
                  </div>
                )}
                <div className="jr-drow">
                  <span className="jr-kk">Кадр</span>
                  <span className="jr-vv">#{det.id}</span>
                </div>
              </div>
            )}
          </div>

          {/* Объекты кадра, слева снизу */}
          <div className={`jr-viewer-objects${objectsOpen ? '' : ' closed'}`}>
            <button className="jr-viewer-panel-head" onClick={() => setObjectsOpen((v) => !v)}>
              <span className="jr-sect-lbl">Объекты</span>
              <span className="jr-count">{det.objects.length}</span>
              <span className="jr-caret">{objectsOpen ? '▾' : '▴'}</span>
            </button>
            {objectsOpen && (
              <div className="jr-viewer-panel-body">
                {det.objects.map((o, i) => {
                  const m = resolve(det.config_id, o.cid);
                  return (
                    <div
                      key={i}
                      className={`jr-vobj${hovered === i ? ' hot' : ''}`}
                      onMouseEnter={() => setHovered(i)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <span className="jr-cd" style={{ background: m.color || '#4d8bff' }} />
                      <span className="jr-vobj-name">{m.name || '—'}</span>
                      {o.state && <span className="jr-vobj-state">{o.state}</span>}
                      <span className="jr-cf">{o.cf.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Отметка правдивости — под кадром */}
        <div className="jr-viewer-verdict">
          <button
            className={`jr-vbtn ok${det.verdict === 'true' ? ' on' : ''}`}
            disabled={busy}
            onClick={() => setVerdict('true')}
          >
            ✓ Верно
          </button>
          <button
            className={`jr-vbtn err${det.verdict === 'false' ? ' on' : ''}`}
            disabled={busy}
            onClick={() => setVerdict('false')}
          >
            ✗ Ложное
          </button>
          {det.verdict !== 'unverified' && (
            <button className="jr-vbtn ghost" disabled={busy} onClick={() => setVerdict('unverified')}>
              Сбросить
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
