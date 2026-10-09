import { useEffect, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Modal } from '../../../../app/Modal';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { detClass } from './DetectionRow';
import { VERDICT_CLASS, VERDICT_LABEL } from './Filters';
import { useDetectionShots } from './FrameWithBoxes';
import { fmtCoord, fmtDateTime, fmtTime } from './format';

interface Props {
  det: JournalDetection;
  // Снимок, на котором открыть; null — превью
  initialShot: number | null;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  cameraName: (id: string) => string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onChange: (updated: JournalDetection) => void;
}

/** Кадр целиком: рамка трека поверх снимка, панели снимка и треков, лента снимков. */
export function FrameViewer({
  det,
  initialShot,
  resolve,
  cameraName,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onChange,
}: Props) {
  const { shots, index, shot, tracks, setIndex } = useDetectionShots(det, initialShot);
  const [metaOpen, setMetaOpen] = useState(true);
  const [tracksOpen, setTracksOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  // Снимок мог удалить чистильщик лимита изображений
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [shot?.url]);

  // Стрелки листают обнаружения; снимки — только мышью по ленте; Esc закрывает Modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      else if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPrev, onNext, hasPrev, hasNext]);

  // Повторное нажатие той же кнопки снимает отметку — как и в списке
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

  const cls = detClass(det, resolve);
  const vd = VERDICT_CLASS[det.verdict];
  const w = shot?.frame_w || 0;
  const h = shot?.frame_h || 0;
  const box = w > 0 && h > 0 ? shot?.box : null;
  const gps = det.gps;

  return (
    <Modal
      size="wide"
      className="fv-modal"
      title={`Обнаружение ${det.id} · ${fmtDateTime(det.started_at)}`}
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
            Предыдущее
          </button>
          <button className="btn btn--sm" disabled={!hasNext} onClick={onNext}>
            Следующее
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
          {!shot || missing ? (
            <div className="fv-missing">
              <Icon name="img" className="ico" />
              {shot ? 'Снимок удалён' : 'Снимков нет'}
            </div>
          ) : (
            <div className="fv-frame">
              <img src={shot.url} alt="Снимок обнаружения" onError={() => setMissing(true)} />

              {box && (
                <span
                  className="fv-box"
                  style={{
                    left: `${(box[0] / w) * 100}%`,
                    top: `${(box[1] / h) * 100}%`,
                    width: `${(box[2] / w) * 100}%`,
                    height: `${(box[3] / h) * 100}%`,
                    borderColor: cls.color,
                  }}
                >
                  <span className="fv-box-lbl" style={{ background: cls.color }}>
                    {cls.name} {shot.confidence != null ? shot.confidence.toFixed(2) : ''}
                  </span>
                </span>
              )}

              <div className={`fv-panel fv-meta${metaOpen ? '' : ' is-closed'}`}>
                <button className="fv-panel-h" onClick={() => setMetaOpen((v) => !v)}>
                  <span className="eyebrow">Снимок</span>
                  <Icon name="chev" size={12} className="ico" />
                </button>
                {metaOpen && (
                  <div className="fv-panel-b">
                    <div className="kv"><span className="k">Время</span><span className="v">{shot.ts != null ? fmtTime(shot.ts) : '—'}</span></div>
                    <div className="kv"><span className="k">Трек</span><span className="v">{shot.track_no != null ? `#${shot.track_no}` : '—'}</span></div>
                    <div className="kv"><span className="k">Уверенность</span><span className="v">{shot.confidence != null ? shot.confidence.toFixed(2) : '—'}</span></div>
                    {w > 0 && h > 0 && (
                      <div className="kv"><span className="k">Размер</span><span className="v">{w}×{h}</span></div>
                    )}
                    <div className="kv">
                      <span className="k">Координаты</span>
                      <span className="v">{gps ? `${fmtCoord(gps.lat)}, ${fmtCoord(gps.lon)}` : '—'}</span>
                    </div>
                    {gps?.speed != null && (
                      <div className="kv"><span className="k">Скорость</span><span className="v">{(gps.speed * 3.6).toFixed(1)} км/ч</span></div>
                    )}
                    {gps?.course != null && (
                      <div className="kv"><span className="k">Курс</span><span className="v">{gps.course.toFixed(1)}°</span></div>
                    )}
                  </div>
                )}
              </div>

              {tracks.length > 0 && (
                <div className={`fv-panel fv-objs${tracksOpen ? '' : ' is-closed'}`}>
                  <button className="fv-panel-h" onClick={() => setTracksOpen((v) => !v)}>
                    <span className="eyebrow">Треки</span>
                    <span className="num">{tracks.length}</span>
                    <Icon name="chev" size={12} className="ico" />
                  </button>
                  {tracksOpen && (
                    <div className="fv-panel-b">
                      {tracks.map((t) => (
                        <div key={t.track_no} className={`fv-trk${t.track_no === shot.track_no ? ' is-hot' : ''}`}>
                          <span className="num">#{t.track_no}</span>
                          <span className="t">{t.class_name || cls.name}</span>
                          <span className="num">{fmtTime(t.first_ts)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {shots.length > 1 && (
          <div className="fv-strip">
            <span className="num">{index + 1} / {shots.length}</span>
            {shots.map((s, i) => (
              <button
                key={s.image_id}
                type="button"
                className={i === index ? 'is-on' : ''}
                data-tip={[s.track_no != null ? `#${s.track_no}` : '', s.ts != null ? fmtTime(s.ts) : ''].filter(Boolean).join(' · ')}
                onClick={() => setIndex(i)}
              >
                <img src={s.url} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
