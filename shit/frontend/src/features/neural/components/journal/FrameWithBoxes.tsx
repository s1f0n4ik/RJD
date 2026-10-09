import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { journalApi } from '../../api/journal';
import type { JournalDetection, JournalDetectionFull, JournalShot } from '../../api/journal-types';

interface Props {
  shot: JournalShot | null;
  color: string;
  name: string;
  /** Компактный режим (превью в списке): только рамка, без подписи. */
  compact?: boolean;
  className?: string;
}

// Превью обнаружения тем же адресом, что у снимка в карточке, — браузер берёт его из кэша
export function previewShot(det: JournalDetection): JournalShot | null {
  const p = det.preview;
  if (!p || !det.frame_url) return null;
  return {
    image_id: p.image_id,
    url: `/api/journal/image/${p.image_id}.jpg`,
    box: p.box ?? null,
    frame_w: p.frame_w ?? null,
    frame_h: p.frame_h ?? null,
    confidence: p.confidence ?? null,
    ts: p.ts ?? null,
    track_no: p.track_no ?? null,
  };
}

// Снимки обнаружения: до ответа карточки — одно превью; начальный снимок — initial или превью
export function useDetectionShots(det: JournalDetection | null, initial: number | null = null) {
  const [full, setFull] = useState<JournalDetectionFull | null>(null);
  const [shotId, setShotId] = useState<number | null>(initial);
  const id = det?.id ?? null;
  const version = det ? `${det.images}/${det.tracks}/${det.ended_at}` : '';

  const lastId = useRef(id);
  useEffect(() => {
    if (lastId.current === id) return;
    lastId.current = id;
    setShotId(null);
  }, [id]);

  useEffect(() => {
    if (id == null) return;
    let alive = true;
    journalApi
      .get(id)
      .then((f) => {
        if (alive) setFull(f);
      })
      .catch(() => {
        /* останется превью */
      });
    return () => {
      alive = false;
    };
  }, [id, version]);

  const own = full && full.id === id ? full : null;
  const shots = useMemo<JournalShot[]>(() => {
    if (own) return own.image_list;
    const p = det ? previewShot(det) : null;
    return p ? [p] : [];
  }, [own, det]);

  const wanted = shotId ?? det?.preview?.image_id ?? null;
  const found = shots.findIndex((s) => s.image_id === wanted);
  const index = found >= 0 ? found : 0;

  return {
    shots,
    index,
    shot: shots[index] ?? null,
    tracks: own?.track_list ?? [],
    setIndex: (i: number) => {
      const s = shots[i];
      if (s) setShotId(s.image_id);
    },
  };
}

// Рамка трека рисуется поверх чистого снимка в процентах от размеров кадра
export function FrameWithBoxes({ shot, color, name, compact = false, className }: Props) {
  const w = shot?.frame_w || 0;
  const h = shot?.frame_h || 0;
  const box = w > 0 && h > 0 ? shot?.box : null;

  // Снимок мог удалить чистильщик лимита изображений — обнаружение остаётся
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [shot?.url]);

  return (
    <div
      className={`fb${compact ? ' is-compact' : ''}${className ? ' ' + className : ''}`}
      style={{ aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : '16 / 9' }}
    >
      {!shot || missing ? (
        <span className="fb-missing">
          <Icon name="img" className="ico" />
          {!compact && (shot ? 'Снимок удалён' : 'Снимков нет')}
        </span>
      ) : (
        <img className="fb-img" src={shot.url} alt="" loading="lazy" onError={() => setMissing(true)} />
      )}
      {!missing && box && (
        <span
          className="fb-box"
          style={{
            left: `${(box[0] / w) * 100}%`,
            top: `${(box[1] / h) * 100}%`,
            width: `${(box[2] / w) * 100}%`,
            height: `${(box[3] / h) * 100}%`,
            borderColor: color,
          }}
        >
          {!compact && (
            <span className="fb-box-lbl" style={{ background: color }}>
              {name} {shot?.confidence != null ? shot.confidence.toFixed(2) : ''}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
