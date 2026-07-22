import { useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { FrameWithBoxes } from './FrameWithBoxes';
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
  onChange: (updated: JournalDetection) => void;
}

/** Строка «Телеметрия»: превью + время/камера/GPS + классы + отметка правдивости.
 *  Вся работа с записью идёт прямо здесь — отдельной панели кадра больше нет. */
export function DetectionRow({ det, selected, resolve, onSelect, onChange }: Props) {
  const [note, setNote] = useState(det.verdict_note ?? '');
  const [busy, setBusy] = useState(false);

  // Уникальные классы кадра для чипов (по cid, берём самый уверенный объект).
  const classes = new Map<number, ClassMeaning & { cf: number }>();
  for (const o of det.objects) {
    const m = resolve(det.config_id, o.cid);
    const prev = classes.get(o.cid);
    if (!prev || o.cf > prev.cf) classes.set(o.cid, { ...m, cf: o.cf });
  }

  const setVerdict = async (verdict: Verdict, e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await journalApi.setVerdict(det.id, verdict, note || undefined);
      onChange({ ...det, verdict, verdict_note: note || null, verdict_at: Date.now() });
    } catch {
      /* ошибку показывать в строке некуда — вердикт просто не применится */
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if ((det.verdict_note ?? '') === note) return;
    setBusy(true);
    try {
      await journalApi.setVerdict(det.id, det.verdict, note || undefined);
      onChange({ ...det, verdict_note: note || null });
    } catch {
      /* см. выше */
    } finally {
      setBusy(false);
    }
  };

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
      <div className="jr-row-main">
        <FrameWithBoxes det={det} resolve={resolve} compact className="jr-thumb" />

        <div className="jr-meta">
          <div className="jr-row-top">
            <span className="jr-time">{fmtTime(det.ts)}</span>
            <span className="jr-cam">{det.camera_id}</span>
            {det.gps ? (
              <span className="jr-gps">
                {fmtCoord(det.gps.lat)}, {fmtCoord(det.gps.lon)}
              </span>
            ) : (
              <span className="jr-gps jr-nogps">без координат</span>
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

        <div className="jr-row-verdict">
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
          </div>
        </div>
      </div>

      {selected && (
        <input
          className="jr-note"
          placeholder="Заметка о правдивости…"
          value={note}
          disabled={busy}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </div>
  );
}
