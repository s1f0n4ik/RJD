import { memo } from 'react';
import type { JournalDetection } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { VERDICT_CLASS, VERDICT_LABEL } from './Filters';
import { fmtTime } from './format';

interface Props {
  det: JournalDetection;
  selected: boolean;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  cameraName: (id: string) => string;
  onSelect: (id: number) => void;
}

export interface ClassAgg extends ClassMeaning {
  count: number;
  cf: number;
}

// Классы кадра: сколько объектов класса и лучшая уверенность среди них
export function aggClasses(det: JournalDetection, resolve: Props['resolve']): ClassAgg[] {
  const agg = new Map<number, ClassAgg>();
  for (const o of det.objects) {
    const prev = agg.get(o.cid);
    if (prev) {
      prev.count += 1;
      prev.cf = Math.max(prev.cf, o.cf);
    } else {
      agg.set(o.cid, { ...resolve(det.config_id, o.cid), count: 1, cf: o.cf });
    }
  }
  return [...agg.values()].sort((a, b) => b.count - a.count || b.cf - a.cf);
}

export function classColor(c: ClassMeaning): string {
  return c.color || c.superColor || '#5b9dff';
}

function DetectionRowInner({ det, selected, resolve, cameraName, onSelect }: Props) {
  const classes = aggClasses(det, resolve);
  const vd = VERDICT_CLASS[det.verdict];

  return (
    <button type="button" className={`j-row${selected ? ' is-sel' : ''}`} onClick={() => onSelect(det.id)}>
      <span className="j-ts">{fmtTime(det.ts)}</span>
      <span className="j-cam">{cameraName(det.camera_id)}</span>
      <span className="j-obj">
        {classes.map((c, i) => (
          <span className="otag" key={i}>
            <i className="sw-col" style={{ background: classColor(c) }} />
            {c.name || '—'}
            {c.count > 1 && <span className="num">×{c.count}</span>}
            <span className="num">{c.cf.toFixed(2)}</span>
          </span>
        ))}
      </span>
      <span className="j-tr">
        {det.track_id != null ? (
          <span className="seps">
            <b>#{det.track_id}</b>
            {det.event ? <span>{det.event}</span> : null}
          </span>
        ) : (
          '—'
        )}
      </span>
      <span className={`vd ${vd.vd}`}>
        <span className={`dot${vd.dot ? ' ' + vd.dot : ''}`} />
        {VERDICT_LABEL[det.verdict]}
      </span>
    </button>
  );
}

// Список длинный, а опрос head меняет состояние раздела — без мемоизации перерисовывались бы все строки
export const DetectionRow = memo(DetectionRowInner);
