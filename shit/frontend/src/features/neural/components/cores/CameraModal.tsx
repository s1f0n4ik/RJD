import { useEffect, useRef, useState } from 'react';
import type { CamOption } from './CoresSection';

interface CameraModalProps {
    configName: string;
    cams: CamOption[];
    /** Выбранная камера потока (id) или null. */
    current: string | null;
    /** Камеры, занятые другими потоками — недоступны. */
    excluded: Set<string>;
    onPick: (camId: string | null) => void;
    onClose: () => void;
}

interface Region {
    id: string;
    row: number; col: number; rowSpan: number; colSpan: number;
    camId: string | null;
}

/** Настройка камер потока: «Одна камера» (применяется) или «Сетка»
 *  (интерактивный редактор, но применить пока нельзя — не реализовано). */
export function CameraModal({ configName, cams, current, excluded, onPick, onClose }: CameraModalProps) {
    const [mode, setMode] = useState<'single' | 'grid'>('single');

    // ── состояние редактора сетки (локальное, не применяется) ──
    const [rows, setRows] = useState(2);
    const [cols, setCols] = useState(2);
    const [regions, setRegions] = useState<Region[]>([]);
    const [selRegion, setSelRegion] = useState<string | null>(null);
    const [picker, setPicker] = useState<{ regionId: string; x: number; y: number } | null>(null);
    const [draw, setDraw] = useState<{ active: boolean; sr: number; sc: number; er: number; ec: number }>(
        { active: false, sr: 0, sc: 0, er: 0, ec: 0 },
    );
    const rid = useRef(1);

    const camName = (id: string) => cams.find((c) => c.id === id)?.name ?? id;

    // Delete удаляет выбранную область
    useEffect(() => {
        if (mode !== 'grid') return;
        const h = (e: KeyboardEvent) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && selRegion &&
                !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) {
                e.preventDefault();
                deleteRegion(selRegion);
            }
        };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, selRegion]);

    // закрытие поповера по клику мимо
    useEffect(() => {
        if (!picker) return;
        const h = (e: MouseEvent) => {
            const t = e.target as HTMLElement;
            if (!t.closest('.cam-pop') && !t.closest('[data-region]')) setPicker(null);
        };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, [picker]);

    function resetGrid(nextRows = rows, nextCols = cols) {
        setRows(nextRows); setCols(nextCols);
        setRegions([]); setSelRegion(null); setPicker(null);
    }

    function commitDraw() {
        if (!draw.active) return;
        const minR = Math.min(draw.sr, draw.er), maxR = Math.max(draw.sr, draw.er);
        const minC = Math.min(draw.sc, draw.ec), maxC = Math.max(draw.sc, draw.ec);
        const overlap = regions.some((r) =>
            !(maxR < r.row || minR > r.row + r.rowSpan - 1 || maxC < r.col || minC > r.col + r.colSpan - 1));
        if (!overlap) {
            setRegions((rs) => [...rs, {
                id: 'r' + rid.current++, row: minR, col: minC,
                rowSpan: maxR - minR + 1, colSpan: maxC - minC + 1, camId: null,
            }]);
        }
        setDraw((d) => ({ ...d, active: false }));
    }

    function deleteRegion(id: string) {
        setRegions((rs) => rs.filter((r) => r.id !== id));
        if (selRegion === id) setSelRegion(null);
        setPicker((p) => (p && p.regionId === id ? null : p));
    }

    function assignRegion(id: string, camId: string | null) {
        setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, camId } : r)));
        setPicker(null);
    }

    // камеры, доступные области: не заняты другими потоками и другими областями
    function selectableFor(regId: string): CamOption[] {
        const usedByOthers = new Set<string>();
        for (const r of regions) if (r.id !== regId && r.camId) usedByOthers.add(r.camId);
        const cur = regions.find((r) => r.id === regId)?.camId;
        return cams.filter((c) => c.id === cur || (!excluded.has(c.id) && !usedByOthers.has(c.id)));
    }

    const gridCovered = (() => {
        const total = rows * cols;
        if (!total || !regions.length) return false;
        const cov = new Array(total).fill(false);
        for (const r of regions)
            for (let rr = r.row; rr < r.row + r.rowSpan; rr++)
                for (let cc = r.col; cc < r.col + r.colSpan; cc++) cov[rr * cols + cc] = true;
        return cov.every(Boolean) && regions.every((r) => r.camId);
    })();

    const covered: Record<string, Region> = {};
    for (const r of regions)
        for (let rr = r.row; rr < r.row + r.rowSpan; rr++)
            for (let cc = r.col; cc < r.col + r.colSpan; cc++) covered[rr + '_' + cc] = r;

    const inDraw = (r: number, c: number) => draw.active &&
        r >= Math.min(draw.sr, draw.er) && r <= Math.max(draw.sr, draw.er) &&
        c >= Math.min(draw.sc, draw.ec) && c <= Math.max(draw.sc, draw.ec);

    const pickerRegion = picker ? regions.find((r) => r.id === picker.regionId) : null;

    return (
        <div className="cam-ov" onMouseDown={onClose}>
            <div className="cam-modal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="cam-mhead">
                    <div>
                        <div className="n">Камеры потока</div>
                        <div className="sub">{configName}</div>
                    </div>
                    <button className="icon-btn" onClick={onClose} title="Закрыть">×</button>
                </div>

                <div className="cam-mbody">
                    <div className="cam-seg">
                        <button className={`cam-seg-btn${mode === 'single' ? ' on' : ''}`} onClick={() => setMode('single')}>Одна камера</button>
                        <button className={`cam-seg-btn${mode === 'grid' ? ' on' : ''}`} onClick={() => setMode('grid')}>Сетка</button>
                    </div>

                    {mode === 'single' ? (
                        <div className="cam-list">
                            {cams.length === 0 && <span className="hint">нет доступных камер</span>}
                            {cams.map((c) => {
                                const isSel = current === c.id;
                                const dis = excluded.has(c.id) && !isSel;
                                return (
                                    <div
                                        key={c.id}
                                        className={`cam-item${isSel ? ' sel' : dis ? ' dis' : ''}`}
                                        onClick={() => !dis && onPick(isSel ? null : c.id)}
                                    >
                                        <span className="ci-dot" />
                                        <span className="ci-nm">{c.name}</span>
                                        <span className="ci-rs">{c.resolution ?? ''}{dis ? ' · занята' : ''}</span>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <>
                            <div className="ed-dims">
                                <div className="g"><span className="field-label">Строки</span>
                                    <input className="cam-num" type="number" min={1} max={6} value={rows}
                                        onChange={(e) => resetGrid(Math.max(1, Math.min(6, +e.target.value || 1)), cols)} /></div>
                                <div className="g"><span className="field-label">Столбцы</span>
                                    <input className="cam-num" type="number" min={1} max={6} value={cols}
                                        onChange={(e) => resetGrid(rows, Math.max(1, Math.min(6, +e.target.value || 1)))} /></div>
                                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                                    disabled={!regions.length} onClick={() => resetGrid()}>очистить</button>
                            </div>
                            <div className="ed-hint">🖱 Зажмите ЛКМ и выделите область под камеру. Клик по области — выбор камеры; × или Delete — удалить.</div>

                            <div
                                className="ed-grid"
                                style={{ gridTemplateColumns: `repeat(${cols},1fr)`, gridTemplateRows: `repeat(${rows},1fr)` }}
                                onMouseUp={commitDraw}
                                onMouseLeave={commitDraw}
                            >
                                {Array.from({ length: rows * cols }, (_, i) => {
                                    const r = Math.floor(i / cols), c = i % cols;
                                    const reg = covered[r + '_' + c];
                                    if (reg) {
                                        if (reg.row !== r || reg.col !== c) return null;
                                        const cls = `ed-region ${reg.camId ? 'assigned' : 'unset'}${selRegion === reg.id ? ' sel' : ''}`;
                                        return (
                                            <div
                                                key={i}
                                                data-region={reg.id}
                                                className={cls}
                                                style={{ gridColumn: `${c + 1} / span ${reg.colSpan}`, gridRow: `${r + 1} / span ${reg.rowSpan}` }}
                                                onMouseDown={(e) => {
                                                    setSelRegion(reg.id);
                                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                                    setPicker({ regionId: reg.id, x: rect.left, y: rect.bottom + 6 });
                                                }}
                                            >
                                                <button className="del" title="Удалить область (Del)"
                                                    onMouseDown={(e) => { e.stopPropagation(); deleteRegion(reg.id); }}>×</button>
                                                <span className="rc-name">{reg.camId ? camName(reg.camId) : 'выберите камеру'}</span>
                                                <span className="rc-span">{reg.rowSpan}×{reg.colSpan}</span>
                                            </div>
                                        );
                                    }
                                    return (
                                        <div
                                            key={i}
                                            className={`ed-cell${inDraw(r, c) ? ' in' : ''}`}
                                            style={{ gridColumn: c + 1, gridRow: r + 1 }}
                                            onMouseDown={() => { setPicker(null); setSelRegion(null); setDraw({ active: true, sr: r, sc: c, er: r, ec: c }); }}
                                            onMouseEnter={() => setDraw((d) => (d.active ? { ...d, er: r, ec: c } : d))}
                                        />
                                    );
                                })}
                            </div>

                            <div className="grid-note"><span className="d" />Раскладка-сетка ещё не реализована — применить нельзя.</div>
                        </>
                    )}
                </div>

                <div className="cam-mfoot">
                    <span className="cam-note">
                        {mode === 'single'
                            ? (current ? 'камера выбрана' : 'камера не выбрана')
                            : (gridCovered ? 'сетка заполнена' : 'заполните все ячейки')}
                    </span>
                    <button
                        className="btn btn-primary"
                        disabled={mode === 'grid'}
                        title={mode === 'grid' ? 'Раскладка-сетка ещё не реализована' : undefined}
                        onClick={onClose}
                    >
                        Готово
                    </button>
                </div>
            </div>

            {/* Поповер выбора камеры для области */}
            {picker && pickerRegion && (() => {
                const sel = selectableFor(pickerRegion.id);
                const left = Math.max(8, Math.min(picker.x, window.innerWidth - 262));
                const top = Math.min(picker.y, window.innerHeight - 300);
                return (
                    <div className="cam-pop" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
                        <span className="pop-h">Доступные камеры</span>
                        {sel.length === 0 && <span className="pop-empty">свободных камер нет</span>}
                        {sel.map((c) => (
                            <button
                                key={c.id}
                                className={`pop-item${c.id === pickerRegion.camId ? ' sel' : ''}`}
                                onClick={() => assignRegion(pickerRegion.id, c.id)}
                            >
                                <span>{c.name}</span>
                                <span className="pi-rs">{c.resolution ?? ''}</span>
                            </button>
                        ))}
                        {pickerRegion.camId && (
                            <button className="pop-item rm" onClick={() => assignRegion(pickerRegion.id, null)}>снять камеру</button>
                        )}
                    </div>
                );
            })()}
        </div>
    );
}
