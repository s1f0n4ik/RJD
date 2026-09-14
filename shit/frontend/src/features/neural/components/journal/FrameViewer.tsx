import { useEffect, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Modal } from '../../../../app/Modal';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { VERDICT_CLASS, VERDICT_LABEL } from './Filters';
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

/** Просмотр кадра: боксы поверх чистого изображения, мета и
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

  // Стрелки листают — просмотр рассчитан на разбор с клавиатуры; Esc закрывает Modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      else if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPrev, onNext, hasPrev, hasNext]);

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
  const vd = VERDICT_CLASS[det.verdict];

  return (
    <Modal
      size="wide"
      className="fv-modal"
      title={`Запись ${det.id} · ${fmtDateTime(det.ts)}`}
      onClose={onClose}
      head={
        <>
          {det.config_id && <span className="tag is-acc">{det.config_id}</span>}
          <span className="tag">{cameraName(det.camera_id)}</span>
        </>
      }
      footer={
        <>
          <button className="btn btn--sm" disabled={!hasPrev} onClick={onPrev}>
            <Icon name="prev" className="ico" />
            Предыдущая
          </button>
          <button className="btn btn--sm" disabled={!hasNext} onClick={onNext}>
            Следующая
            <Icon name="next" className="ico" />
          </button>
          <span className={`vd ${vd.vd} spacer`}>
            <span className={`dot${vd.dot ? ' ' + vd.dot : ''}`} />
            {VERDICT_LABEL[det.verdict]}
          </span>
          <button
            className={`btn btn--ok${det.verdict === 'true' ? ' is-on' : ''}`}
            disabled={busy}
            onClick={() => setVerdict('true')}
          >
            Подтвердить
          </button>
          <button
            className={`btn btn--err${det.verdict === 'false' ? ' is-on' : ''}`}
            disabled={busy}
            onClick={() => setVerdict('false')}
          >
            Ложное
          </button>
        </>
      }
    >
      <div className="modal-b fv-body">
        <div className="fv-stage">
          <div className="fv-frame">
            {missing ? (
              <div className="fv-missing">
                <Icon name="img" className="ico" />
                Кадр удалён
              </div>
            ) : (
              <img src={journalApi.frameUrl(det.id)} alt="Кадр обнаружения" onError={() => setMissing(true)} />
            )}

            {!missing &&
              canDraw &&
              det.objects.map((o, i) => {
                const m = resolve(det.config_id, o.cid);
                const color = m.color || m.superColor || '#5b9dff';
                return (
                  <span
                    key={i}
                    className={`fv-box${o.state ? ' ' + o.state : ''}${hovered === i ? ' is-hot' : ''}`}
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
                    <span className="fv-box-lbl" style={{ background: color }}>
                      {m.name || '—'} {o.cf.toFixed(2)}
                    </span>
                  </span>
                );
              })}

            <div className={`fv-panel fv-meta${metaOpen ? '' : ' is-closed'}`}>
              <button className="fv-panel-h" onClick={() => setMetaOpen((v) => !v)}>
                <span className="eyebrow">Данные кадра</span>
                <Icon name="chev" size={12} className="ico" />
              </button>
              {metaOpen && (
                <div className="fv-panel-b">
                  <div className="kv"><span className="k">Время</span><span className="v">{fmtDateTime(det.ts)}</span></div>
                  <div className="kv"><span className="k">Unix</span><span className="v">{det.ts}</span></div>
                  {canDraw && (
                    <div className="kv"><span className="k">Размер</span><span className="v">{w}×{h}</span></div>
                  )}
                  <div className="kv">
                    <span className="k">GPS</span>
                    <span className="v">{det.gps ? `${fmtCoord(det.gps.lat)}, ${fmtCoord(det.gps.lon)}` : '—'}</span>
                  </div>
                  {det.gps && (
                    <>
                      <div className="kv"><span className="k">Скорость</span><span className="v">{(det.gps.speed * 3.6).toFixed(1)} км/ч</span></div>
                      <div className="kv"><span className="k">Курс</span><span className="v">{det.gps.course.toFixed(1)}°</span></div>
                      <div className="kv"><span className="k">Высота</span><span className="v">{Math.round(det.gps.alt)} м</span></div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className={`fv-panel fv-objs${objectsOpen ? '' : ' is-closed'}`}>
              <button className="fv-panel-h" onClick={() => setObjectsOpen((v) => !v)}>
                <span className="eyebrow">Объекты</span>
                <span className="num">{det.objects.length}</span>
                <Icon name="chev" size={12} className="ico" />
              </button>
              {objectsOpen && (
                <div className="fv-panel-b">
                  {det.objects.map((o, i) => {
                    const m = resolve(det.config_id, o.cid);
                    return (
                      <div
                        key={i}
                        className={`fv-obj${hovered === i ? ' is-hot' : ''}`}
                        onMouseEnter={() => setHovered(i)}
                        onMouseLeave={() => setHovered(null)}
                      >
                        <i className="sw-col" style={{ background: m.color || m.superColor || '#5b9dff' }} />
                        <span className="t">{m.name || '—'}</span>
                        {o.state && <span className="tag">{o.state}</span>}
                        <span className="num">{o.cf.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
