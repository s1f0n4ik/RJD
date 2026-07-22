import { journalApi } from '../../api/journal';
import type { JournalDetection } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';

interface Props {
  det: JournalDetection;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  /** Компактный режим (превью в списке): только рамки, без подписей. */
  compact?: boolean;
  /** false — картинку не монтируем (запись далеко от экрана либо вышла за
   *  лимит одновременно загруженных изображений). Место под неё сохраняем. */
  showImage?: boolean;
  className?: string;
}

// В журнале лежит ЧИСТЫЙ кадр без нарисованных боксов — так он пригоден для
// дообучения. Рамки рисуем здесь, поверх изображения, по координатам из БД:
// box = [x, y, w, h] в пикселях кадра, поэтому переводим их в проценты и
// позиционируем абсолютно — тогда наложение не зависит от размера на экране.
export function FrameWithBoxes({
  det,
  resolve,
  compact = false,
  showImage = true,
  className,
}: Props) {
  const w = det.width || 0;
  const h = det.height || 0;
  const canDraw = w > 0 && h > 0;

  // Пропорции контейнера задаём по реальному кадру: иначе изображение обрежется
  // под фиксированное соотношение, а боксы считаются в процентах от контейнера —
  // и разъедутся относительно объектов.
  return (
    <div
      className={`jr-frame${compact ? ' compact' : ''}${className ? ' ' + className : ''}`}
      style={canDraw ? { aspectRatio: `${w} / ${h}` } : undefined}
    >
      {showImage ? (
        <img className="jr-frame-img" src={journalApi.frameUrl(det.id)} alt="" loading="lazy" />
      ) : (
        <span className="jr-frame-stub" />
      )}
      {showImage &&
        canDraw &&
        det.objects.map((o, i) => {
          const m = resolve(det.config_id, o.cid);
          const color = m.color || m.superColor || '#4d8bff';
          const style = {
            left: `${(o.box[0] / w) * 100}%`,
            top: `${(o.box[1] / h) * 100}%`,
            width: `${(o.box[2] / w) * 100}%`,
            height: `${(o.box[3] / h) * 100}%`,
            borderColor: color,
          };
          return (
            <span
              key={i}
              className={`jr-box${o.state ? ' ' + o.state : ''}`}
              style={style}
              title={`${m.name || '—'} · ${o.cf.toFixed(2)}${o.state ? ' · ' + o.state : ''}`}
            >
              {!compact && (
                <span className="jr-box-lbl" style={{ background: color }}>
                  {m.name || '—'} {o.cf.toFixed(2)}
                </span>
              )}
            </span>
          );
        })}
    </div>
  );
}
