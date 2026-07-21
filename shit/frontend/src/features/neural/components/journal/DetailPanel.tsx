import { useEffect, useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalDetection, Verdict } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { fmtCoord, fmtDateTime } from './format';

interface Props {
  det: JournalDetection;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  onChange: (updated: JournalDetection) => void;
}

/** Деталь выбранного кадра: полное изображение, метаданные, отметка правдивости. */
export function DetailPanel({ det, resolve, onChange }: Props) {
  const [note, setNote] = useState(det.verdict_note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // При смене выбранной записи подтягиваем её заметку в поле.
  useEffect(() => {
    setNote(det.verdict_note ?? '');
    setErr(null);
  }, [det.id, det.verdict_note]);

  const setVerdict = async (verdict: Verdict) => {
    setBusy(true);
    setErr(null);
    try {
      await journalApi.setVerdict(det.id, verdict, note || undefined);
      onChange({ ...det, verdict, verdict_note: note || null, verdict_at: Date.now() });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const classes = new Map<number, ClassMeaning & { cf: number }>();
  for (const o of det.objects) {
    const m = resolve(det.config_id, o.cid);
    const prev = classes.get(o.cid);
    if (!prev || o.cf > prev.cf) classes.set(o.cid, { ...m, cf: o.cf });
  }

  return (
    <div className="jr-detail">
      <img className="jr-detail-img" src={journalApi.frameUrl(det.id)} alt="Кадр обнаружения" />

      <div className="jr-chips">
        {[...classes.values()].map((c, i) => (
          <span className="jr-chip" key={i}>
            <span className="jr-cd" style={{ background: c.color }} />
            {c.name || '—'}
            <span className="jr-cf">{c.cf.toFixed(2)}</span>
          </span>
        ))}
      </div>

      <div className="jr-detail-rows">
        <div className="jr-drow">
          <span className="jr-kk">Кадр</span>
          <span className="jr-vv">#{det.id}</span>
        </div>
        <div className="jr-drow">
          <span className="jr-kk">Время</span>
          <span className="jr-vv">{fmtDateTime(det.ts)}</span>
        </div>
        <div className="jr-drow">
          <span className="jr-kk">GPS</span>
          <span className="jr-vv">
            {det.gps ? `${fmtCoord(det.gps.lat)}, ${fmtCoord(det.gps.lon)}` : 'нет данных'}
          </span>
        </div>
        <div className="jr-drow">
          <span className="jr-kk">Камера</span>
          <span className="jr-vv">{det.camera_id}</span>
        </div>
        <div className="jr-drow">
          <span className="jr-kk">Конфиг</span>
          <span className="jr-vv">{det.config_id ?? '—'}</span>
        </div>
      </div>

      <input
        className="jr-note"
        placeholder="Заметка о правдивости…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="jr-verdict-actions">
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

      {err && <div className="jr-err">{err}</div>}
    </div>
  );
}
