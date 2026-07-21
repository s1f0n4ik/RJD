import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { fmtCoord, fmtTime } from './format';

const VERDICT_LABEL: Record<Verdict, string> = {
  unverified: 'не пров.',
  true: 'верно',
  false: 'ложное',
};

interface Props {
  det: JournalDetection;
  selected: boolean;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  onSelect: (id: number) => void;
}

/** Строка «Телеметрия»: превью + время/камера/GPS + чипы классов + вердикт. */
export function DetectionRow({ det, selected, resolve, onSelect }: Props) {
  // Уникальные классы кадра для чипов (по cid).
  const classes = new Map<number, ClassMeaning & { cf: number }>();
  for (const o of det.objects) {
    const m = resolve(det.config_id, o.cid);
    const prev = classes.get(o.cid);
    if (!prev || o.cf > prev.cf) classes.set(o.cid, { ...m, cf: o.cf });
  }

  return (
    <div
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
      <img className="jr-thumb" src={journalApi.frameUrl(det.id)} alt="" loading="lazy" />

      <div className="jr-meta">
        <div className="jr-row-top">
          <span className="jr-time">{fmtTime(det.ts)}</span>
          <span className="jr-cam">{det.camera_id}</span>
          {det.gps && (
            <span className="jr-gps">
              {fmtCoord(det.gps.lat)}, {fmtCoord(det.gps.lon)}
            </span>
          )}
        </div>
        <div className="jr-chips">
          {[...classes.values()].map((c, i) => (
            <span className="jr-chip" key={i}>
              <span className="jr-cd" style={{ background: c.color }} />
              {c.name || '—'}
              <span className="jr-cf">{c.cf.toFixed(2)}</span>
            </span>
          ))}
        </div>
      </div>

      <span className={`jr-verdict ${det.verdict}`}>
        <span className="jr-d" />
        {VERDICT_LABEL[det.verdict]}
      </span>
    </div>
  );
}
