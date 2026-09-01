/**
 * Модель отображения.
 *
 * Внутри экрана сетка одна: матрица rows × cols и ячейки со span'ами.
 * Пресеты тулбара — её заготовки, «произвольная» — она же, нарисованная руками.
 *
 * На диске формат остаётся прежним (квадраты числом, остальное 'custom'):
 * его понимают и старые сетки, и сохранённые новым экраном. Нормализация при
 * чтении и обратная сборка при записи живут здесь — это единственная точка,
 * где два представления встречаются.
 */

import type { SavedLayout } from '../../hooks/Layouts';

export interface GridCell {
    id: string;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
}

export interface Grid {
    rows: number;
    cols: number;
    cells: GridCell[];
}

// Наложения на кадр. Рамки обнаружений сюда не входят: они включаются у
// конкретной камеры, потому что зависят от её потоков
export interface Overlays {
    name: boolean;
    time: boolean;
}

export interface LayoutState {
    name: string;
    grid: Grid;
    /** cellId → id камеры или виртуального потока */
    cells: Record<string, string>;
    /** cameraId → ключ показываемого потока (stream_N) */
    streams: Record<string, string>;
    /** cameraId → включена ли коррекция дисторсии */
    corrections: Record<string, boolean>;
    /** cameraId → показывать ли рамки обнаружений */
    detections: Record<string, boolean>;
    overlays: Overlays;
    /** Состояние вывода 360 на момент сохранения */
    surround?: SavedLayout['surround'];
}

export const DEFAULT_OVERLAYS: Overlays = { name: true, time: false };

// ── Пресеты ────────────────────────────────────────────────────

// Id ячеек — порядковые номера строкой: так раскладки остаются совместимыми
// между собой и со старым форматом, где ключами activeCells были индексы
function rectGrid(rows: number, cols: number): Grid {
    const cells: GridCell[] = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            cells.push({ id: String(cells.length), row, col, rowSpan: 1, colSpan: 1 });
        }
    }
    return { rows, cols, cells };
}

// Крупная ячейка 2×2 в левом верхнем углу и пять обычных вокруг
function onePlusFive(): Grid {
    const cells: GridCell[] = [
        { id: '0', row: 0, col: 0, rowSpan: 2, colSpan: 2 },
        { id: '1', row: 0, col: 2, rowSpan: 1, colSpan: 1 },
        { id: '2', row: 1, col: 2, rowSpan: 1, colSpan: 1 },
        { id: '3', row: 2, col: 0, rowSpan: 1, colSpan: 1 },
        { id: '4', row: 2, col: 1, rowSpan: 1, colSpan: 1 },
        { id: '5', row: 2, col: 2, rowSpan: 1, colSpan: 1 },
    ];
    return { rows: 3, cols: 3, cells };
}

export interface Preset {
    key: string;
    label: string;
    grid: Grid;
}

export const PRESETS: Preset[] = [
    { key: '1',   label: '1',   grid: rectGrid(1, 1) },
    { key: '2x2', label: '2×2', grid: rectGrid(2, 2) },
    { key: '3x3', label: '3×3', grid: rectGrid(3, 3) },
    { key: '1+5', label: '1+5', grid: onePlusFive() },
    { key: '2x4', label: '2×4', grid: rectGrid(2, 4) },
    { key: '4x4', label: '4×4', grid: rectGrid(4, 4) },
];

export const MAX_FREE_SIDE = 6;

// Какому пресету отвечает сетка; null — произвольная
export function presetOf(grid: Grid): string | null {
    const found = PRESETS.find(p => sameGrid(p.grid, grid));
    return found?.key ?? null;
}

function sameGrid(a: Grid, b: Grid): boolean {
    if (a.rows !== b.rows || a.cols !== b.cols) return false;
    if (a.cells.length !== b.cells.length) return false;
    return a.cells.every((cell, i) => {
        const other = b.cells[i];
        return cell.row === other.row && cell.col === other.col
            && cell.rowSpan === other.rowSpan && cell.colSpan === other.colSpan;
    });
}

// ── Чтение и запись формата на диске ───────────────────────────

const SQUARE_SIZES: Record<number, number> = { 1: 1, 4: 2, 9: 3, 16: 4 };

export function layoutFromSaved(saved: SavedLayout): LayoutState {
    return {
        name: saved.name,
        grid: gridFromSaved(saved),
        cells: { ...(saved.activeCells ?? {}) },
        streams: { ...(saved.streams ?? {}) },
        corrections: { ...(saved.corrections ?? {}) },
        detections: { ...(saved.detections ?? {}) },
        overlays: { ...DEFAULT_OVERLAYS, ...(saved.overlays ?? {}) },
        surround: saved.surround,
    };
}

function gridFromSaved(saved: SavedLayout): Grid {
    if (saved.gridSize === 'custom') {
        const rows = saved.customGridRows || 3;
        const cols = saved.customGridCols || 3;
        const cells = (saved.customCells ?? []).map(cell => ({
            id: cell.id,
            row: cell.row,
            col: cell.col,
            rowSpan: cell.rowSpan,
            colSpan: cell.colSpan,
        }));
        return { rows, cols, cells };
    }

    // 'single' — единственная ячейка со своим историческим ключом
    if (saved.gridSize === 'single') {
        return { rows: 1, cols: 1, cells: [{ id: 'single', row: 0, col: 0, rowSpan: 1, colSpan: 1 }] };
    }

    const side = SQUARE_SIZES[Number(saved.gridSize)] ?? 3;
    return rectGrid(side, side);
}

export function layoutToSaved(state: LayoutState, timestamp: number): SavedLayout {
    const square = squareSizeOf(state.grid);

    const base = {
        name: state.name,
        activeCells: state.cells,
        streams: state.streams,
        corrections: state.corrections,
        detections: state.detections,
        overlays: state.overlays as unknown as Record<string, boolean>,
        surround: state.surround,
        timestamp,
    };

    if (square !== null) {
        return { ...base, gridSize: square };
    }

    return {
        ...base,
        gridSize: 'custom',
        customGridRows: state.grid.rows,
        customGridCols: state.grid.cols,
        customCells: state.grid.cells.map(cell => ({ ...cell })),
    };
}

// Квадратная сетка без span'ов пишется числом — так её читает и старый слой
function squareSizeOf(grid: Grid): number | null {
    if (grid.rows !== grid.cols) return null;
    if (grid.cells.length !== grid.rows * grid.cols) return null;
    if (grid.cells.some(c => c.rowSpan !== 1 || c.colSpan !== 1)) return null;
    if (grid.cells.some((c, i) => c.id !== String(i))) return null;
    const size = grid.rows * grid.cols;
    return SQUARE_SIZES[size] ? size : null;
}

// ── Пустое отображение ─────────────────────────────────────────

export function emptyLayout(name = ''): LayoutState {
    return {
        name,
        grid: PRESETS[2].grid,
        cells: {},
        streams: {},
        corrections: {},
        detections: {},
        overlays: { ...DEFAULT_OVERLAYS },
    };
}

// Привязки, чьи ячейки не попали в текущую сетку: показываются как «вне сетки»
export function offGridBindings(state: LayoutState): Array<[string, string]> {
    const ids = new Set(state.grid.cells.map(c => c.id));
    return Object.entries(state.cells).filter(([cellId]) => !ids.has(cellId));
}
