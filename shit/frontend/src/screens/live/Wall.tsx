/**
 * Стена ячеек — общая для редактора и трансляции.
 *
 * Chromium не тянет полтора десятка сессий разом, поэтому плееры монтируются
 * по одному: подъём видно (ячейка сама пишет «подключение…»), а разбор при
 * смене отображения скрыт плашкой с прогрессом — иначе ячейки гасли бы по
 * очереди на глазах. Уход со страницы разбирает всё разом: смотреть уже
 * некому.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerStats, PlayerStatus } from '../../components/webrtc/useWebRTCPlayer';
import { Icon } from '../../app/Icons';
import { CellPlayer } from './CellPlayer';
import { SurroundCell } from './SurroundCell';
import { resolveStream, type WallSource } from './sources';
import type { Grid, LayoutState } from './model';
import './wall.css';

// Пауза между подъёмом соседних плееров
const OPEN_STEP_MS = 200;

// Пауза между закрытием соседних сессий
const CLOSE_STEP_MS = 120;

export interface WallProps {
    grid: Grid;
    layout: LayoutState;
    sources: WallSource[];
    /** Меняется, когда сменилось отображение целиком: повод разобрать стену */
    switchKey: string;
    signalingUrlOf: (sourceId: string) => string;
    deviceTimeMs: number | null;
    /** Редактор разрешает перетаскивание, выбор и очистку ячеек */
    editable?: boolean;
    selectedCell?: string | null;
    onSelectCell?: (cellId: string) => void;
    onAssign?: (cellId: string, sourceId: string) => void;
    onSwap?: (from: string, to: string) => void;
    onRemove?: (cellId: string) => void;
    onCorrectedChange?: (cameraId: string, value: boolean) => void;
    onDetectionsChange?: (cameraId: string, value: boolean) => void;
    onSurroundManualChange?: (value: boolean) => void;
    /** Сколько ячеек реально в эфире из занятых */
    onLiveCount?: (live: number, total: number) => void;
    /** Показатели выбранной ячейки; остальные ячейки родителя не дёргают */
    onCellStats?: (stats: PlayerStats | null) => void;
    /** Кнопки слоёв на самой ячейке. В редакторе они не нужны: тумблеры
     *  живут в блоке «Ячейка» правой колонки */
    cellControls?: boolean;
}

export function Wall({
    grid,
    layout,
    sources,
    switchKey,
    signalingUrlOf,
    deviceTimeMs,
    editable = false,
    selectedCell = null,
    onSelectCell,
    onAssign,
    onSwap,
    onRemove,
    onCorrectedChange,
    onDetectionsChange,
    onSurroundManualChange,
    onLiveCount,
    onCellStats,
    cellControls = true,
}: WallProps) {
    const [mounted, setMounted] = useState<string[]>([]);
    const [closing, setClosing] = useState<{ total: number; done: number } | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [statuses, setStatuses] = useState<Record<string, PlayerStatus>>({});

    const mountedRef = useRef<string[]>([]);
    mountedRef.current = mounted;
    const switchRef = useRef(switchKey);
    const wallRef = useRef<HTMLDivElement>(null);

    const sourceOf = useCallback(
        (id: string | undefined) => (id ? sources.find(s => s.id === id) : undefined),
        [sources],
    );

    // Занятые ячейки текущей сетки, в порядке слева направо сверху вниз
    const target = useMemo(
        () => grid.cells.map(cell => cell.id).filter(id => Boolean(layout.cells[id])),
        [grid, layout.cells],
    );

    // ─── Разбор при смене отображения ───────────────────────────

    useEffect(() => {
        if (switchRef.current === switchKey) return;
        switchRef.current = switchKey;

        const total = mountedRef.current.length;
        if (total === 0) return;

        setClosing({ total, done: 0 });
        let done = 0;
        const timer = window.setInterval(() => {
            done += 1;
            setMounted(prev => prev.slice(0, Math.max(0, prev.length - 1)));
            if (done >= total) {
                window.clearInterval(timer);
                setClosing(null);
            } else {
                setClosing({ total, done });
            }
        }, CLOSE_STEP_MS);

        return () => window.clearInterval(timer);
    }, [switchKey]);

    // ─── Подъём по одному ───────────────────────────────────────

    useEffect(() => {
        if (closing) return;

        // Ячейки, которых в цели больше нет, снимаем сразу: это одиночная
        // правка, а не смена отображения
        const stale = mounted.filter(id => !target.includes(id));
        if (stale.length) {
            setMounted(prev => prev.filter(id => target.includes(id)));
            return;
        }

        const next = target.find(id => !mounted.includes(id));
        if (!next) return;

        const timer = window.setTimeout(
            () => setMounted(prev => (prev.includes(next) ? prev : [...prev, next])),
            mounted.length === 0 ? 0 : OPEN_STEP_MS,
        );
        return () => window.clearTimeout(timer);
    }, [target, mounted, closing]);

    // ─── Счётчик живых сессий ───────────────────────────────────

    useEffect(() => {
        const live = target.filter(id => statuses[id] === 'streaming').length;
        onLiveCount?.(live, target.length);
    }, [statuses, target, onLiveCount]);

    const setStatus = useCallback((cellId: string, status: PlayerStatus) => {
        setStatuses(prev => (prev[cellId] === status ? prev : { ...prev, [cellId]: status }));
    }, []);

    // ─── Раскрытие ячейки ───────────────────────────────────────

    useEffect(() => {
        if (!expanded) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setExpanded(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [expanded]);

    const goFullscreen = (cellId: string) => {
        // Полный экран просим у контейнера ячейки, а не у video: иначе канвас
        // рамок и кнопки 360 остаются за кадром
        const node = wallRef.current?.querySelector(`[data-cell="${cellId}"]`);
        if (node instanceof HTMLElement) node.requestFullscreen?.().catch(() => {});
    };

    // ─── Перетаскивание ─────────────────────────────────────────

    const onDrop = (event: React.DragEvent, cellId: string) => {
        event.preventDefault();
        const raw = event.dataTransfer.getData('text/plain');
        if (raw.startsWith('source:')) {
            onAssign?.(cellId, raw.slice('source:'.length));
            return;
        }
        if (raw.startsWith('cell:')) {
            const from = raw.slice('cell:'.length);
            if (from !== cellId) onSwap?.(from, cellId);
        }
    };

    // ─── Разметка ───────────────────────────────────────────────

    const renderBody = (cellId: string) => {
        const sourceId = layout.cells[cellId];
        if (!sourceId) {
            return (
                <div className="cell-msg">
                    Ячейка свободна
                    {editable && <><br /><span className="cell-msg-dim">нажмите или перетащите источник из списка</span></>}
                </div>
            );
        }

        const source = sourceOf(sourceId);
        if (!source) {
            return <div className="cell-msg"><b>Источник удалён</b>{sourceId}</div>;
        }

        if (source.offline) {
            return <div className="cell-msg"><b>{source.name}</b>устройство не отвечает</div>;
        }

        if (source.kind === 'virtual' && !source.active) {
            return <div className="cell-msg"><b>{source.name}</b>модуль не запущен</div>;
        }

        if (source.kind === 'camera' && source.viewStreams.length === 0) {
            return <div className="cell-msg"><b>{source.name}</b>нет потока для просмотра</div>;
        }

        if (!mounted.includes(cellId)) {
            return <div className="cell-msg">{source.name}<br /><span className="cell-msg-dim">подключение…</span></div>;
        }

        if (source.kind === 'virtual') {
            return (
                <SurroundCell
                    key={`${sourceId}-${switchKey}`}
                    streamId={sourceId}
                    name={source.name}
                    signalingUrl={signalingUrlOf(sourceId)}
                    overlays={layout.overlays}
                    deviceTimeMs={deviceTimeMs}
                    collectStats={!expanded || expanded === cellId}
                    initialManual={layout.surround?.manual}
                    onManualChange={onSurroundManualChange}
                    onStatus={status => setStatus(cellId, status)}
                    onStats={cellId === selectedCell ? onCellStats : undefined}
                />
            );
        }

        const { key } = resolveStream(source, layout.streams[sourceId]);

        return (
            <CellPlayer
                key={`${sourceId}-${switchKey}`}
                cameraId={sourceId}
                cameraName={source.name}
                signalingUrl={signalingUrlOf(sourceId)}
                streamKey={key}
                canDetect={source.hasNeural}
                canCorrect={source.hasBirdview}
                corrected={Boolean(layout.corrections[sourceId])}
                onCorrectedChange={value => onCorrectedChange?.(sourceId, value)}
                showDetections={Boolean(layout.detections[sourceId])}
                onDetectionsChange={value => onDetectionsChange?.(sourceId, value)}
                overlays={layout.overlays}
                deviceTimeMs={deviceTimeMs}
                collectStats={!expanded || expanded === cellId}
                onStatus={status => setStatus(cellId, status)}
                onStats={cellId === selectedCell ? onCellStats : undefined}
                controls={cellControls}
            />
        );
    };

    return (
        <div className="wallwrap">
            <div
                className={`wall${expanded ? ' is-expanded' : ''}`}
                ref={wallRef}
                style={{
                    // minmax(0,1fr): иначе трек не уже своего содержимого — стена
                    // вылезает за экран, а пустые ячейки схлопываются в полоски
                    gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
                }}
            >
                {grid.cells.map(cell => {
                    const sourceId = layout.cells[cell.id];
                    const source = sourceOf(sourceId);
                    const empty = !sourceId;
                    const broken = Boolean(sourceId) && (!source || source.offline
                        || (source.kind === 'virtual' && !source.active)
                        || (source.kind === 'camera' && source.viewStreams.length === 0));

                    const hidden = Boolean(expanded) && expanded !== cell.id;

                    return (
                        <div
                            key={cell.id}
                            data-cell={cell.id}
                            className={[
                                'cell',
                                empty ? 'is-off' : '',
                                broken ? 'is-off is-err' : '',
                                selectedCell === cell.id ? 'is-sel' : '',
                                hidden ? 'is-hidden' : '',
                                expanded === cell.id ? 'is-solo' : '',
                            ].filter(Boolean).join(' ')}
                            style={{
                                gridArea: `${cell.row + 1} / ${cell.col + 1} / span ${cell.rowSpan} / span ${cell.colSpan}`,
                            }}
                            draggable={editable && Boolean(sourceId)}
                            onDragStart={event => event.dataTransfer.setData('text/plain', `cell:${cell.id}`)}
                            onDragOver={event => { if (editable) event.preventDefault(); }}
                            onDrop={event => { if (editable) onDrop(event, cell.id); }}
                            onClick={() => onSelectCell?.(cell.id)}
                            onDoubleClick={() => setExpanded(prev => (prev === cell.id ? null : cell.id))}
                        >
                            {renderBody(cell.id)}

                            {Boolean(sourceId) && (
                                <div className="cell-tools">
                                    <button
                                        className="cell-btn"
                                        title="Во весь экран"
                                        onClick={event => { event.stopPropagation(); goFullscreen(cell.id); }}
                                    >
                                        <Icon name="full" />
                                    </button>
                                    {editable && (
                                        <button
                                            className="cell-btn"
                                            title="Убрать из ячейки"
                                            onClick={event => { event.stopPropagation(); onRemove?.(cell.id); }}
                                        >
                                            <Icon name="x" />
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {closing && (
                <div className="wall-mask">
                    <span className="wall-mask-cap">Переключение отображения</span>
                    <div className="wall-mask-bar">
                        <i style={{ width: `${Math.round((closing.done / closing.total) * 100)}%` }} />
                    </div>
                    <span className="wall-mask-num">{closing.done} из {closing.total}</span>
                </div>
            )}
        </div>
    );
}
