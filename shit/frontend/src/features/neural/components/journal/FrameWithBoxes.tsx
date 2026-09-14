import { useEffect, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { journalApi } from '../../api/journal';
import type { JournalDetection } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';

interface Props {
  det: JournalDetection;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  /** Компактный режим (превью в списке): только рамки, без подписей. */
  compact?: boolean;
  className?: string;
}

// В журнале лежит ЧИСТЫЙ кадр без нарисованных боксов — так он пригоден для
// дообучения. Рамки рисуем здесь, поверх изображения, по координатам из БД:
// box = [x, y, w, h] в пикселях кадра, поэтому переводим их в проценты и
// позиционируем абсолютно — тогда наложение не зависит от размера на экране.
export function FrameWithBoxes({ det, resolve, compact = false, className }: Props) {
  const w = det.width || 0;
  const h = det.height || 0;
  const canDraw = w > 0 && h > 0;

  // Кадр мог быть удалён чистильщиком лимита изображений — запись остаётся
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [det.id]);

  return (
    <div
      className={`fb${compact ? ' is-compact' : ''}${className ? ' ' + className : ''}`}
      style={canDraw ? { aspectRatio: `${w} / ${h}` } : undefined}
    >
      {missing ? (
        <span className="fb-missing">
          <Icon name="img" className="ico" />
          {!compact && 'Кадр удалён'}
        </span>
      ) : (
        <img
          className="fb-img"
          src={journalApi.frameUrl(det.id)}
          alt=""
          loading="lazy"
          onError={() => setMissing(true)}
        />
      )}
      {!missing &&
        canDraw &&
        det.objects.map((o, i) => {
          const m = resolve(det.config_id, o.cid);
          const color = m.color || m.superColor || '#5b9dff';
          const style = {
            left: `${(o.box[0] / w) * 100}%`,
            top: `${(o.box[1] / h) * 100}%`,
            width: `${(o.box[2] / w) * 100}%`,
            height: `${(o.box[3] / h) * 100}%`,
            borderColor: color,
          };
          return (
            <span key={i} className={`fb-box${o.state ? ' ' + o.state : ''}`} style={style}>
              {!compact && (
                <span className="fb-box-lbl" style={{ background: color }}>
                  {m.name || '—'} {o.cf.toFixed(2)}
                </span>
              )}
            </span>
          );
        })}
    </div>
  );
}
