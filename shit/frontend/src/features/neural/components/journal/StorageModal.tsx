import { useEffect, useRef, useState } from 'react';
import { journalApi } from '../../api/journal';
import type { JournalStorageState } from '../../api/journal';
import { DateRangePicker } from './DateRangePicker';
import { fmtDateTime } from './format';

interface Props {
  onClose: () => void;
  /** После очистки — родитель перезагружает список записей. */
  onPurged: () => void;
}

const GB = 1024 ** 3;

function fmtBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} ГБ`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

/**
 * Хранилище журнала: лимиты (ГБ, 0 = без ограничения) с фактической
 * занятостью и инструмент очистки. При переполнении изображений чистильщик
 * удаляет только JPEG — записи остаются с заглушкой; при переполнении базы
 * старейшие записи уходят вместе со своими изображениями.
 */
export function StorageModal({ onClose, onPurged }: Props) {
  const [state, setState] = useState<JournalStorageState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [imagesDraft, setImagesDraft] = useState('');
  const [dbDraft, setDbDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Граница «старше даты» — настенное время шлюза, закодированное как UTC
  const [purgeBefore, setPurgeBefore] = useState<number | undefined>();
  const [calOpen, setCalOpen] = useState(false);
  const [confirm, setConfirm] = useState<'date' | 'all' | null>(null);
  const [purging, setPurging] = useState(false);
  const [purgeInfo, setPurgeInfo] = useState<string | null>(null);

  const confirmTimer = useRef<number | null>(null);

  useEffect(() => {
    journalApi
      .storageState()
      .then((s) => {
        setState(s);
        setImagesDraft(String(s.images_limit_gb));
        setDbDraft(String(s.db_limit_gb));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [onClose]);

  const parseLimit = (raw: string): number | null => {
    const n = Number(raw.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
  };

  const imagesLimit = parseLimit(imagesDraft);
  const dbLimit = parseLimit(dbDraft);
  const dirty =
    state != null && (imagesLimit !== state.images_limit_gb || dbLimit !== state.db_limit_gb);

  const handleSave = async () => {
    if (imagesLimit == null || dbLimit == null) return;
    setSaving(true);
    setErr(null);
    try {
      const s = await journalApi.saveStorageSettings(imagesLimit, dbLimit);
      setState(s);
      setImagesDraft(String(s.images_limit_gb));
      setDbDraft(String(s.db_limit_gb));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Первый клик взводит красное подтверждение, второй — удаляет
  const armConfirm = (kind: 'date' | 'all') => {
    setConfirm(kind);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirm(null), 4000);
  };

  const handlePurge = async (beforeTs?: number) => {
    setConfirm(null);
    setPurging(true);
    setErr(null);
    setPurgeInfo(null);
    try {
      const res = await journalApi.purge(beforeTs);
      setState(res);
      setPurgeInfo(`Удалено записей: ${res.deleted}, изображений: ${res.files_deleted}`);
      onPurged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPurging(false);
    }
  };

  const usageRow = (label: string, used: number, limitGb: number | null) => {
    const limit = limitGb != null && limitGb > 0 ? limitGb * GB : 0;
    const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
    return (
      <div className="jr-storage-usage">
        <span className="jr-storage-usage-text">
          {label}: занято {fmtBytes(used)}
          {limit > 0 ? ` из ${limitGb} ГБ` : ' · без ограничения'}
        </span>
        {limit > 0 && (
          <span className="jr-storage-bar">
            <span
              className={`jr-storage-bar-fill${ratio >= 0.9 ? ' hot' : ''}`}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal jr-storage-modal">
        <div className="jr-storage-head">
          <span className="modal-title">Хранилище журнала</span>
          <button className="jr-icon-btn" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">
            ✕
          </button>
        </div>

        {err && <div className="error-box">{err}</div>}

        {state == null && !err ? (
          <div className="modal-body">Загрузка…</div>
        ) : state != null && (
          <>
            <div className="jr-storage-block">
              <div className="field-row">
                <div className="field-group">
                  <label className="field-label">Лимит изображений, ГБ</label>
                  <input
                    type="number"
                    className={`field-input${imagesLimit == null ? ' invalid' : ''}`}
                    min={0}
                    step={0.5}
                    value={imagesDraft}
                    onChange={(e) => setImagesDraft(e.target.value)}
                  />
                  {usageRow('Кадры', state.frames_bytes, imagesLimit)}
                </div>
                <div className="field-group">
                  <label className="field-label">Лимит базы записей, ГБ</label>
                  <input
                    type="number"
                    className={`field-input${dbLimit == null ? ' invalid' : ''}`}
                    min={0}
                    step={0.1}
                    value={dbDraft}
                    onChange={(e) => setDbDraft(e.target.value)}
                  />
                  {usageRow('База', state.db_bytes, dbLimit)}
                </div>
              </div>
              <div className="jr-storage-hint">
                0 — без ограничения. При переполнении удаляется самое старое: изображения — без
                записей (в журнале останется отметка об удалённом кадре), база — записи вместе с
                их изображениями.
              </div>
              <div className="modal-actions">
                {saved && <span className="jr-storage-saved">Сохранено</span>}
                <button
                  className="btn btn-primary"
                  onClick={() => void handleSave()}
                  disabled={saving || !dirty || imagesLimit == null || dbLimit == null}
                >
                  {saving ? 'Сохранение…' : 'Сохранить лимиты'}
                </button>
              </div>
            </div>

            <div className="jr-storage-block">
              <span className="jr-sect-lbl">Очистка</span>
              <div className="jr-storage-purge-row">
                <div className="jr-class-wrap">
                  <button
                    className="btn btn-ghost"
                    disabled={purging}
                    onClick={() => { setCalOpen((v) => !v); setConfirm(null); }}
                  >
                    {purgeBefore != null ? `до ${fmtDateTime(purgeBefore)}` : 'Выбрать дату'}
                  </button>
                  {calOpen && (
                    <>
                      <div className="jr-class-backdrop" onClick={() => setCalOpen(false)} />
                      <DateRangePicker
                        single
                        from={purgeBefore}
                        onApply={(from) => setPurgeBefore(from)}
                        onClose={() => setCalOpen(false)}
                      />
                    </>
                  )}
                </div>
                {confirm === 'date' ? (
                  <button
                    className="btn btn-danger"
                    disabled={purging}
                    onClick={() => void handlePurge(purgeBefore)}
                  >
                    Точно удалить?
                  </button>
                ) : (
                  <button
                    className="btn btn-ghost"
                    disabled={purging || purgeBefore == null}
                    onClick={() => armConfirm('date')}
                  >
                    Удалить старше даты
                  </button>
                )}
              </div>
              <div className="jr-storage-purge-row">
                {confirm === 'all' ? (
                  <button
                    className="btn btn-danger"
                    disabled={purging}
                    onClick={() => void handlePurge()}
                  >
                    Точно удалить всё?
                  </button>
                ) : (
                  <button className="btn btn-ghost" disabled={purging} onClick={() => armConfirm('all')}>
                    Удалить всё
                  </button>
                )}
                {purging && <span className="jr-storage-hint">Очистка…</span>}
              </div>
              {purgeInfo && <div className="jr-storage-saved">{purgeInfo}</div>}
              <div className="jr-storage-hint">
                Записи удаляются вместе с изображениями. Действие необратимо.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
