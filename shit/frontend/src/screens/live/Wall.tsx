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

interface FCellKey {
    key: string;
    sourceId: string;
}

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
    /** Какие кнопки слоёв показывать на ячейке: в редакторе рамки живут в
     *  правой колонке, а коррекция остаётся под рукой */
    cellControls?: 'none' | 'correction' | 'all';
    /** Камеры с настроенным сопоставлением калибровки */
    correctionLinks?: Record<string, boolean>;
    /** Запрос коррекции из правой колонки */
    correctionRequest?: { cameraId: string; enable: boolean; nonce: number } | null;
    onCorrectionBusy?: (cameraId: string, busy: boolean) => void;
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
    cellControls = 'all',
    correctionLinks = {},
    correctionRequest = null,
    onCorrectionBusy,
}: WallProps) {
    const [mounted, setMounted] = useState<string[]>([]);
    const [closing, setClosing] = useState<{ total: number; done: number } | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [statuses, setStatuses] = useState<Record<string, PlayerStatus>>({});
    const [dragOver, setDragOver] = useState<string | null>(null);
    const [fullscreenCell, setFullscreenCell] = useState<string | null>(null);
    const [dragSource, setDragSource] = useState<string | null>(null);

    // Пишется из жестов 360 синхронно: dragstart приходит сразу за pointerdown
    const gestureLockRef = useRef(false);

    const mountedRef = useRef<string[]>([]);
    mountedRef.current = mounted;
    const switchRef = useRef(switchKey);
    const wallRef = useRef<HTMLDivElement>(null);

    const sourceOf = useCallback(
        (id: string | undefined) => (id ? sources.find(s => s.id === id) : undefined),
        [sources],
    );

    // Ключ закрепляется за плеером и переезжает вместе с ним: и React, и
    // очередь подъёма видят один и тот же плеер на новом месте. Раздавать
    // ключи по порядку нельзя — при двух ячейках с одной камерой порядок
    // меняется от любой перестановки, и плееры пересоздаются
    const keysRef = useRef({ byCell: new Map<string, FCellKey>(), seq: 0 });

    const cellKeys = useMemo(() => {
        const before = keysRef.current.byCell;
        const after = new Map<string, FCellKey>();
        const taken = new Set<string>();
        const keys: Record<string, string> = {};

        const occupied = grid.cells
            .map(cell => ({ cellId: cell.id, sourceId: layout.cells[cell.id] }))
            .filter(item => Boolean(item.sourceId));

        // Ячейка не меняла источник — ключ остаётся за ней
        occupied.forEach(({ cellId, sourceId }) => {
            const kept = before.get(cellId);
            if (!kept || kept.sourceId !== sourceId) return;

            keys[cellId] = kept.key;
            after.set(cellId, kept);
            taken.add(kept.key);
        });

        // Плеер переехал — забирает свой ключ с покинутой ячейки
        occupied.forEach(({ cellId, sourceId }) => {
            if (keys[cellId]) return;

            for (const kept of before.values()) {
                if (kept.sourceId !== sourceId || taken.has(kept.key)) continue;

                keys[cellId] = kept.key;
                after.set(cellId, { key: kept.key, sourceId });
                taken.add(kept.key);
                return;
            }
        });

        // Источник появился впервые — новый ключ
        occupied.forEach(({ cellId, sourceId }) => {
            if (keys[cellId]) return;

            keysRef.current.seq += 1;
            const key = `src:${sourceId}#${keysRef.current.seq}`;
            keys[cellId] = key;
            after.set(cellId, { key, sourceId });
            taken.add(key);
        });

        grid.cells.forEach(cell => {
            if (!keys[cell.id]) keys[cell.id] = `cell:${cell.id}`;
        });

        keysRef.current.byCell = after;
        return keys;
    }, [grid, layout.cells]);

    // Занятые ячейки текущей сетки, в порядке слева направо сверху вниз
    const target = useMemo(
        () => grid.cells
            .filter(cell => Boolean(layout.cells[cell.id]))
            .map(cell => cellKeys[cell.id]),
        [grid, layout.cells, cellKeys],
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
        const live = target.filter(key => statuses[key] === 'streaming').length;
        onLiveCount?.(live, target.length);
    }, [statuses, target, onLiveCount]);

    const setStatus = useCallback((key: string, status: PlayerStatus) => {
        setStatuses(prev => (prev[key] === status ? prev : { ...prev, [key]: status }));
    }, []);

    // Полный экран могут закрыть и мимо кнопки — клавишей или жестом
    useEffect(() => {
        const onChange = () => {
            const node = document.fullscreenElement;
            setFullscreenCell(node instanceof HTMLElement ? node.dataset.cell ?? null : null);
        };
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
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

    // Полный экран просим у контейнера ячейки, а не у video: иначе канвас
    // рамок и кнопки слоёв остаются за кадром
    const toggleFullscreen = (cellId: string) => {
        const node = wallRef.current?.querySelector(`[data-cell="${cellId}"]`);

        // Полный экран уже занят этой ячейкой — кнопка работает на выход
        if (document.fullscreenElement === node) {
            document.exitFullscreen().catch(() => {});
            return;
        }

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

        if (!mounted.includes(cellKeys[cellId])) {
            return (
                <div className="cell-state">
                    <span className="spin" />
                    <span>в очереди на подключение</span>
                </div>
            );
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
                    collectStats={(!expanded || expanded === cellId)
                        && (layout.overlays.stats || cellId === selectedCell)}
                    initialManual={layout.surround?.manual}
                    onManualChange={onSurroundManualChange}
                    onGestureLock={locked => { gestureLockRef.current = locked; }}
                    onStatus={status => setStatus(cellKeys[cellId], status)}
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
                canCorrect={source.hasBirdview && Boolean(correctionLinks[sourceId])}
                corrected={Boolean(layout.corrections[sourceId])}
                onCorrectedChange={value => onCorrectedChange?.(sourceId, value)}
                showDetections={Boolean(layout.detections[sourceId])}
                onDetectionsChange={value => onDetectionsChange?.(sourceId, value)}
                overlays={layout.overlays}
                deviceTimeMs={deviceTimeMs}
                collectStats={(!expanded || expanded === cellId)
                    && (layout.overlays.stats || cellId === selectedCell)}
                onStatus={status => setStatus(cellKeys[cellId], status)}
                onStats={cellId === selectedCell ? onCellStats : undefined}
                controls={cellControls}
                correctionRequest={correctionRequest?.cameraId === sourceId ? correctionRequest : undefined}
                onCorrectionBusy={busy => onCorrectionBusy?.(sourceId, busy)}
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
                    const key = cellKeys[cell.id];
                    const source = sourceOf(sourceId);
                    const empty = !sourceId;
                    const broken = Boolean(sourceId) && (!source || source.offline
                        || (source.kind === 'virtual' && !source.active)
                        || (source.kind === 'camera' && source.viewStreams.length === 0));

                    const hidden = Boolean(expanded) && expanded !== cell.id;

                    return (
                        <div
                            key={key}
                            data-cell={cell.id}
                            className={[
                                'cell',
                                empty ? 'is-off' : '',
                                broken ? 'is-off is-err' : '',
                                selectedCell === cell.id ? 'is-sel' : '',
                                dragOver === cell.id ? 'is-drop' : '',
                                hidden ? 'is-hidden' : '',
                                expanded === cell.id ? 'is-solo' : '',
                            ].filter(Boolean).join(' ')}
                            style={{
                                gridArea: `${cell.row + 1} / ${cell.col + 1} / span ${cell.rowSpan} / span ${cell.colSpan}`,
                            }}
                            draggable={editable && Boolean(sourceId)}
                            onDragStart={event => {
                                // Жесты 360 держат перетаскивание: иначе вращение
                                // превращается в перенос ячейки
                                if (gestureLockRef.current) {
                                    event.preventDefault();
                                    return;
                                }
                                event.dataTransfer.setData('text/plain', `cell:${cell.id}`);
                                setDragSource(cell.id);
                            }}
                            onDragEnd={() => { setDragSource(null); setDragOver(null); }}
                            onDragOver={event => {
                                if (!editable) return;
                                event.preventDefault();
                                if (dragOver !== cell.id) setDragOver(cell.id);
                            }}
                            onDragLeave={event => {
                                // Уход на дочерний элемент — не уход из ячейки
                                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                                setDragOver(prev => (prev === cell.id ? null : prev));
                            }}
                            onDrop={event => {
                                setDragOver(null);
                                setDragSource(null);
                                if (editable) onDrop(event, cell.id);
                            }}
                            onClick={() => onSelectCell?.(cell.id)}
                            onDoubleClick={() => setExpanded(prev => (prev === cell.id ? null : cell.id))}
                        >
                            {renderBody(cell.id)}

                            {dragOver === cell.id && dragSource !== cell.id && (
                                <div className="cell-drop" />
                            )}

                            {Boolean(sourceId) && (
                                <div
                                    className="cell-tools"
                                    onDoubleClick={event => event.stopPropagation()}
                                >
                                    <button
                                        className="cell-btn"
                                        title={fullscreenCell === cell.id ? 'Выйти из полного экрана' : 'Во весь экран'}
                                        onClick={event => { event.stopPropagation(); toggleFullscreen(cell.id); }}
                                    >
                                        <Icon name={fullscreenCell === cell.id ? 'x' : 'full'} />
                                    </button>
                                    {editable && onRemove && (
                                        <button
                                            className="cell-btn"
                                            title="Убрать из ячейки"
                                            onClick={event => { event.stopPropagation(); onRemove(cell.id); }}
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
