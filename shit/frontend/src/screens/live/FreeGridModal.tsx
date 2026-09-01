/**
 * Произвольная сетка: матрица и нарисованные по ней ячейки.
 *
 * Протяжка по свободным клеткам создаёт ячейку, клик по готовой — убирает.
 * Пустые клетки допустимы: это фон, а не ошибка, — «1+5» из макета устроен
 * ровно так. Наложения запрещены протяжкой, а не правкой постфактум.
 */

import { useMemo, useState } from 'react';
import { Modal } from '../../app/Modal';
import { MAX_FREE_SIDE, type Grid, type GridCell } from './model';

interface FreeGridModalProps {
    grid: Grid;
    onClose: () => void;
    onApply: (grid: Grid) => void;
}

interface DrawRange {
    row1: number;
    col1: number;
    row2: number;
    col2: number;
}

function normalize(range: DrawRange) {
    return {
        top: Math.min(range.row1, range.row2),
        left: Math.min(range.col1, range.col2),
        bottom: Math.max(range.row1, range.row2),
        right: Math.max(range.col1, range.col2),
    };
}

function covers(cell: GridCell, row: number, col: number): boolean {
    return row >= cell.row && row < cell.row + cell.rowSpan
        && col >= cell.col && col < cell.col + cell.colSpan;
}

export function FreeGridModal({ grid, onClose, onApply }: FreeGridModalProps) {
    const [rows, setRows] = useState(grid.rows);
    const [cols, setCols] = useState(grid.cols);
    const [cells, setCells] = useState<GridCell[]>(grid.cells.map(cell => ({ ...cell })));
    const [draw, setDraw] = useState<DrawRange | null>(null);

    const cellAt = (row: number, col: number) => cells.find(cell => covers(cell, row, col));

    const resize = (nextRows: number, nextCols: number) => {
        const safeRows = Math.max(1, Math.min(MAX_FREE_SIDE, nextRows));
        const safeCols = Math.max(1, Math.min(MAX_FREE_SIDE, nextCols));
        setRows(safeRows);
        setCols(safeCols);
        // Ячейки, вышедшие за новую матрицу, убираем: держать невидимое нельзя
        setCells(prev => prev.filter(cell =>
            cell.row + cell.rowSpan <= safeRows && cell.col + cell.colSpan <= safeCols));
    };

    const startDraw = (row: number, col: number) => {
        if (cellAt(row, col)) {
            setCells(prev => prev.filter(cell => !covers(cell, row, col)));
            return;
        }
        setDraw({ row1: row, col1: col, row2: row, col2: col });
    };

    const moveDraw = (row: number, col: number) => {
        if (!draw) return;
        setDraw({ ...draw, row2: row, col2: col });
    };

    const finishDraw = () => {
        if (!draw) return;
        const { top, left, bottom, right } = normalize(draw);
        setDraw(null);

        // Протяжка поверх занятого не рисует ничего — это защита, а не правка
        for (let row = top; row <= bottom; row++) {
            for (let col = left; col <= right; col++) {
                if (cellAt(row, col)) return;
            }
        }

        setCells(prev => [...prev, {
            id: String(prev.length),
            row: top,
            col: left,
            rowSpan: bottom - top + 1,
            colSpan: right - left + 1,
        }]);
    };

    // Порядок ячеек — по строкам и столбцам: так номера совпадают с чтением
    const ordered = useMemo(() => {
        return [...cells]
            .sort((a, b) => (a.row - b.row) || (a.col - b.col))
            .map((cell, index) => ({ ...cell, id: String(index) }));
    }, [cells]);

    const inDraw = (row: number, col: number): boolean => {
        if (!draw) return false;
        const { top, left, bottom, right } = normalize(draw);
        return row >= top && row <= bottom && col >= left && col <= right;
    };

    return (
        <Modal
            title="Произвольная сетка"
            className="freegrid-modal"
            onClose={onClose}
            footer={
                <>
                    <button className="btn" onClick={() => setCells([])}>Очистить</button>
                    <span className="spacer" />
                    <button className="btn" onClick={onClose}>Отмена</button>
                    <button
                        className="btn btn--acc"
                        disabled={ordered.length === 0}
                        onClick={() => onApply({ rows, cols, cells: ordered })}
                    >
                        Применить
                    </button>
                </>
            }
        >
            <div className="modal-b">
                <div className="freegrid">
                    <div className="freegrid-side">
                        <div className="field">
                            <label>Строк</label>
                            <input
                                className="inp"
                                type="number"
                                min={1}
                                max={MAX_FREE_SIDE}
                                value={rows}
                                onChange={event => resize(Number(event.target.value), cols)}
                            />
                        </div>
                        <div className="field">
                            <label>Колонок</label>
                            <input
                                className="inp"
                                type="number"
                                min={1}
                                max={MAX_FREE_SIDE}
                                value={cols}
                                onChange={event => resize(rows, Number(event.target.value))}
                            />
                        </div>

                        <p className="hint">
                            Протяните по свободным клеткам, чтобы создать ячейку; нажмите готовую, чтобы убрать.
                            Пустые клетки остаются фоном. Матрица — не больше {MAX_FREE_SIDE}×{MAX_FREE_SIDE}.
                        </p>

                        <p className="hint">Ячеек: {ordered.length}</p>
                    </div>

                    <div className="freegrid-main">
                        <div
                            className="freegrid-matrix"
                            style={{
                                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                                gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                            }}
                            onPointerUp={finishDraw}
                            onPointerLeave={() => setDraw(null)}
                        >
                            {Array.from({ length: rows }).map((_, row) =>
                                Array.from({ length: cols }).map((__, col) => (
                                    <div
                                        key={`${row}-${col}`}
                                        className={[
                                            'freegrid-tile',
                                            cellAt(row, col) ? 'is-taken' : '',
                                            inDraw(row, col) ? 'is-draw' : '',
                                        ].filter(Boolean).join(' ')}
                                        style={{ gridArea: `${row + 1} / ${col + 1} / span 1 / span 1` }}
                                        onPointerDown={() => startDraw(row, col)}
                                        onPointerEnter={() => moveDraw(row, col)}
                                    />
                                )),
                            )}

                            {ordered.map(cell => (
                                <div
                                    key={cell.id}
                                    className="freegrid-cell"
                                    style={{
                                        gridArea: `${cell.row + 1} / ${cell.col + 1} / span ${cell.rowSpan} / span ${cell.colSpan}`,
                                    }}
                                >
                                    {Number(cell.id) + 1}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
