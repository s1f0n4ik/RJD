import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../../../app/Modal';
import { useToast } from '../../../birdview/components/common/Toast';
import { journalApi } from '../../api/journal';
import type { JournalStorageState } from '../../api/journal';
import { DateRangePicker } from './DateRangePicker';
import { fmtDate } from './format';

interface Props {
  onClose: () => void;
  /** После очистки — родитель перезагружает список записей. */
  onPurged: () => void;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// Лимиты задаются в гигабайтах, а занято бывает и несколько мегабайт: в ГБ
// такое округлялось в «0,00». Единицу выбираем по величине.
function fmtSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1).replace('.', ',')} ГБ`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

interface DiskProps {
  label: string;
  used: number;
  limitGb: number | null;
}

// Занятость: полоса только при заданном лимите, жёлтая от 90 %
function Disk({ label, used, limitGb }: DiskProps) {
  const limit = limitGb != null && limitGb > 0 ? limitGb * GB : 0;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="j-disk">
      <div className="j-disk-h">
        <b>{label}</b>
        <span className="num">
          {fmtSize(used)}
          {limit > 0 ? ` / ${limitGb} ГБ` : ''}
        </span>
      </div>
      <div className="bar">
        <i className={ratio >= 0.9 ? 'is-warn' : ''} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * Хранилище журнала: лимиты (ГБ, 0 = без ограничения) с фактической
 * занятостью и инструмент очистки. При переполнении изображений чистильщик
 * удаляет только JPEG — записи остаются с заглушкой; при переполнении базы
 * старейшие записи уходят вместе со своими изображениями.
 */
export function StorageModal({ onClose, onPurged }: Props) {
  const toast = useToast();
  const [state, setState] = useState<JournalStorageState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [imagesDraft, setImagesDraft] = useState('');
  const [dbDraft, setDbDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Граница «старше даты» — настенное время шлюза, закодированное как UTC
  const [purgeMode, setPurgeMode] = useState<'date' | 'all'>('date');
  const [purgeBefore, setPurgeBefore] = useState<number | undefined>();
  const [calOpen, setCalOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [purging, setPurging] = useState(false);

  const dateRef = useRef<HTMLButtonElement>(null);
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
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

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
      toast('Лимиты сохранены', '', 'ok');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Первый клик взводит подтверждение на 4 с, второй — удаляет
  const handlePurgeClick = () => {
    if (!confirm) {
      setConfirm(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirm(false), 4000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirm(false);
    void handlePurge(purgeMode === 'date' ? purgeBefore : undefined);
  };

  const handlePurge = async (beforeTs?: number) => {
    setPurging(true);
    setErr(null);
    try {
      const res = await journalApi.purge(beforeTs);
      setState(res);
      toast('Очистка выполнена', `Записей: ${res.deleted}, кадров: ${res.files_deleted}`, 'ok');
      onPurged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPurging(false);
    }
  };

  const purgeDisabled = purging || (purgeMode === 'date' && purgeBefore == null);

  return (
    <Modal
      title="Хранилище журнала"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost spacer" onClick={onClose}>Закрыть</button>
          <button
            className="btn btn--acc"
            onClick={() => void handleSave()}
            disabled={saving || !dirty || imagesLimit == null || dbLimit == null}
          >
            Сохранить лимиты
          </button>
        </>
      }
    >
      <div className="modal-b">
        {state == null && !err && (
          <div className="j-skel-rows">
            <span className="skel" />
            <span className="skel" />
            <span className="skel" />
          </div>
        )}
        {state != null && (
          <>
            <Disk label="Кадры" used={state.frames_bytes} limitGb={imagesLimit} />
            <Disk label="База записей" used={state.db_bytes} limitGb={dbLimit} />
            <div className="tf-row j-mt">
              <div className="tf">
                <span className="tf-cap">Лимит кадров, ГБ</span>
                <input
                  type="number"
                  className={`tf-in${imagesLimit == null ? ' is-err' : ''}`}
                  min={0}
                  step={0.5}
                  value={imagesDraft}
                  onChange={(e) => setImagesDraft(e.target.value)}
                />
              </div>
              <div className="tf">
                <span className="tf-cap">Лимит базы, ГБ</span>
                <input
                  type="number"
                  className={`tf-in${dbLimit == null ? ' is-err' : ''}`}
                  min={0}
                  step={0.1}
                  value={dbDraft}
                  onChange={(e) => setDbDraft(e.target.value)}
                />
              </div>
            </div>
            <div className="tf-row j-mt j-purge">
              <div className="tf">
                <span className="tf-cap">Очистить записи</span>
                <div className="seg">
                  <button
                    type="button"
                    className={purgeMode === 'date' ? 'is-on' : ''}
                    onClick={() => { setPurgeMode('date'); setConfirm(false); }}
                  >
                    Старше даты
                  </button>
                  <button
                    type="button"
                    className={purgeMode === 'all' ? 'is-on' : ''}
                    onClick={() => { setPurgeMode('all'); setConfirm(false); }}
                  >
                    Все
                  </button>
                </div>
              </div>
              <div className="tf j-purge-date">
                <span className="tf-cap">Дата</span>
                <button
                  type="button"
                  ref={dateRef}
                  className="tf-in is-btn"
                  disabled={purgeMode !== 'date'}
                  onClick={() => { setCalOpen((v) => !v); setConfirm(false); }}
                >
                  {purgeBefore != null ? fmtDate(purgeBefore) : '—'}
                </button>
              </div>
              <button className="btn btn--err" disabled={purgeDisabled} onClick={handlePurgeClick}>
                {confirm ? 'Точно удалить?' : 'Очистить'}
              </button>
            </div>
          </>
        )}
        {err && <div className="hint is-err j-mt">{err}</div>}
      </div>

      {calOpen && dateRef.current && (
        <DateRangePicker
          single
          over
          anchor={dateRef.current}
          from={purgeBefore}
          onApply={(from) => setPurgeBefore(from)}
          onClose={() => setCalOpen(false)}
        />
      )}
    </Modal>
  );
}
