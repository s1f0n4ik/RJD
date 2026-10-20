import { useMemo, useState } from 'react';
import { Modal } from '../../app/Modal';

// Сборка полотна как «Произвольная сетка» «Отображения»: протяжка по свободным клеткам создаёт ячейку, нажатие на готовую убирает

const MAX_SIDE = 6;

export interface GridCell {
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
}

interface CanvasGridModalProps {
    rows: number;
    cols: number;
    cells: GridCell[];
    width: number;
    height: number;
    /** Камера ячейки, которая начинается там же, где тайл с камерой */
    cameraAt: (row: number, col: number) => string | null;
    onClose: () => void;
    onApply: (rows: number, cols: number, cells: GridCell[]) => void;
}

interface DrawRange { row1: number; col1: number; row2: number; col2: number }

const normalize = (d: DrawRange) => ({
    top: Math.min(d.row1, d.row2), left: Math.min(d.col1, d.col2),
    bottom: Math.max(d.row1, d.row2), right: Math.max(d.col1, d.col2),
});

const covers = (c: GridCell, row: number, col: number) =>
    row >= c.row && row < c.row + c.rowSpan && col >= c.col && col < c.col + c.colSpan;

export function CanvasGridModal({ rows: rows0, cols: cols0, cells: cells0, width, height, cameraAt, onClose, onApply }: CanvasGridModalProps) {
    const [rows, setRows] = useState(rows0);
    const [cols, setCols] = useState(cols0);
    const [cells, setCells] = useState<GridCell[]>(cells0);
    const [draw, setDraw] = useState<DrawRange | null>(null);

    const cellAt = (row: number, col: number) => cells.find(c => covers(c, row, col));

    // Ячейки за новой матрицей уходят
    const resize = (r: number, c: number) => {
        const nr = Math.max(1, Math.min(MAX_SIDE, r || 1)), nc = Math.max(1, Math.min(MAX_SIDE, c || 1));
        setRows(nr);
        setCols(nc);
        setCells(prev => prev.filter(x => x.row + x.rowSpan <= nr && x.col + x.colSpan <= nc));
    };

    const startDraw = (row: number, col: number) => {
        if (cellAt(row, col)) { setCells(prev => prev.filter(c => !covers(c, row, col))); return; }
        setDraw({ row1: row, col1: col, row2: row, col2: col });
    };

    const finishDraw = () => {
        if (!draw) return;
        const { top, left, bottom, right } = normalize(draw);
        setDraw(null);
        for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) if (cellAt(r, c)) return;
        setCells(prev => [...prev, { row: top, col: left, rowSpan: bottom - top + 1, colSpan: right - left + 1 }]);
    };

    // Номера ячеек — по строкам и столбцам
    const ordered = useMemo(() => [...cells].sort((a, b) => (a.row - b.row) || (a.col - b.col)), [cells]);

    const inDraw = (row: number, col: number) => {
        if (!draw) return false;
        const { top, left, bottom, right } = normalize(draw);
        return row >= top && row <= bottom && col >= left && col <= right;
    };

    return (
        <Modal
            title="Собрать полотно"
            className="ve-gm"
            head={<span className="ve-gm-size">{width}×{height}</span>}
            onClose={onClose}
            footer={
                <>
                    <button className="btn" onClick={() => setCells([])}>Очистить</button>
                    <span className="spacer" />
                    <button className="btn" onClick={onClose}>Отмена</button>
                    <button className="btn btn--acc" disabled={!ordered.length} onClick={() => onApply(rows, cols, ordered)}>Применить</button>
                </>
            }
        >
            <div className="modal-b ve-gm-b">
                <div className="ve-gm-row">
                    <div className="field">
                        <label>Строк</label>
                        <input className="inp" type="number" min={1} max={MAX_SIDE} value={rows} onChange={e => resize(Number(e.target.value), cols)} />
                    </div>
                    <div className="field">
                        <label>Колонок</label>
                        <input className="inp" type="number" min={1} max={MAX_SIDE} value={cols} onChange={e => resize(rows, Number(e.target.value))} />
                    </div>
                </div>
                <div
                    className="ve-gm-matrix"
                    style={{ aspectRatio: `${width} / ${height}`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
                    onPointerUp={finishDraw}
                    onPointerLeave={() => setDraw(null)}
                >
                    {Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (__, c) => (
                        <div
                            key={`${r}-${c}`}
                            className={`ve-gm-tile${cellAt(r, c) ? ' is-taken' : ''}${inDraw(r, c) ? ' is-draw' : ''}`}
                            style={{ gridArea: `${r + 1} / ${c + 1} / span 1 / span 1` }}
                            onPointerDown={() => startDraw(r, c)}
                            onPointerEnter={() => draw && setDraw({ ...draw, row2: r, col2: c })}
                        />
                    )))}
                    {ordered.map((x, i) => {
                        const cam = cameraAt(x.row, x.col);
                        return (
                            <div key={`${x.row}:${x.col}`} className="ve-gm-cell" style={{ gridArea: `${x.row + 1} / ${x.col + 1} / span ${x.rowSpan} / span ${x.colSpan}` }}>
                                <span>{i + 1}{cam && <em>{cam}</em>}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </Modal>
    );
}
