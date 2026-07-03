import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CameraMatrix } from '../../api/types';
import type { CamOption } from './CoresSection';

interface Props {
  matrix: CameraMatrix;
  cameras: CamOption[];
  /** Камеры, занятые в других слотах — недоступны для выбора. */
  excluded?: Set<string>;
  editable: boolean;
  onChange: (m: CameraMatrix) => void;
}

export function CameraMatrixBuilder({ matrix, cameras, excluded, editable, onChange }: Props) {
  const rows = matrix.length > 0 ? matrix : [];

  const camOf = (id: string) => cameras.find((c) => c.id === id);
  const nameOf = (id: string) => camOf(id)?.name ?? id;
  const resOf = (id: string) => camOf(id)?.resolution;

  // камеры, уже использованные в этой матрице
  const usedHere = new Set<string>();
  for (const r of rows) for (const c of r) usedHere.add(c);

  // доступные для добавления: не заняты тут и не заняты в других слотах
  const selectable = cameras.filter((c) => !usedHere.has(c.id) && !excluded?.has(c.id));

  function appendToRow(row: number, camId: string) {
    onChange(rows.map((r, ri) => (ri === row ? [...r, camId] : r)));
  }

  function addRow(camId: string) {
    onChange([...rows, [camId]]);
  }

  function removeAt(row: number, col: number) {
    onChange(
      rows
        .map((r, ri) => (ri === row ? r.filter((_, ci) => ci !== col) : r))
        .filter((r) => r.length > 0),
    );
  }

  // ── пусто ────────────────────────────────────────────────
  if (rows.length === 0) {
    if (!editable) return <div className="cam-empty-ro">матрица не задана</div>;
    return (
      <CameraPicker cameras={selectable} onSelect={(id) => addRow(id)} wrapClass="cam-pick-full">
        {(open) => (
          <button className="cam-set-btn" onClick={open}>
            Задать матрицу камер
          </button>
        )}
      </CameraPicker>
    );
  }

  // ── матрица ──────────────────────────────────────────────
  return (
    <div className="cam-matrix">
      {rows.map((row, ri) => (
        <div key={ri} className="cam-row">
          {row.map((camId, ci) => (
            <div key={ci} className="cam-cell" title={camId}>
              <span className="cam-cell-id">{nameOf(camId)}</span>
              {resOf(camId) && <span className="cam-cell-res">{resOf(camId)}</span>}
              {editable && (
                <button className="cam-cell-rm" title="Убрать камеру" onClick={() => removeAt(ri, ci)}>
                  ×
                </button>
              )}
            </div>
          ))}
          {editable && (
            <CameraPicker cameras={selectable} onSelect={(id) => appendToRow(ri, id)} wrapClass="cam-pick-right">
              {(open) => (
                <button className="cam-add-right" title="Добавить камеру в ряд" onClick={open}>
                  +
                </button>
              )}
            </CameraPicker>
          )}
        </div>
      ))}
      {editable && (
        <CameraPicker cameras={selectable} onSelect={(id) => addRow(id)} wrapClass="cam-pick-full">
          {(open) => (
            <button className="cam-add-bottom" title="Добавить ряд" onClick={open}>
              +
            </button>
          )}
        </CameraPicker>
      )}
    </div>
  );
}

// ── CameraPicker: render-prop обёртка с выпадающим списком ───

interface PickerProps {
  cameras: CamOption[];
  onSelect: (id: string) => void;
  wrapClass?: string;
  children: (open: () => void) => ReactNode;
}

function CameraPicker({ cameras, onSelect, wrapClass, children }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const filtered = cameras.filter(
    (c) =>
      !search ||
      c.id.toLowerCase().includes(search.toLowerCase()) ||
      c.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div ref={ref} className={`cam-picker-wrap${wrapClass ? ' ' + wrapClass : ''}`}>
      {children(() => setOpen((o) => !o))}
      {open && (
        <div className="cam-picker">
          <input
            autoFocus
            className="cam-picker-search"
            placeholder="поиск камеры..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="cam-picker-list">
            {filtered.length === 0 && <div className="cam-picker-empty">нет камер</div>}
            {filtered.map((c) => (
              <button
                key={c.id}
                className="cam-picker-item"
                onClick={() => {
                  onSelect(c.id);
                  setOpen(false);
                  setSearch('');
                }}
              >
                <span className="cam-picker-cid">{c.name}</span>
                {c.resolution && <span className="cam-picker-cres">{c.resolution}</span>}
                {c.name !== c.id && <span className="cam-picker-cname">{c.id}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
