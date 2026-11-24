/**
 * Стена ячеек — общая для редактора и трансляции.
 *
 * Chromium не тянет полтора десятка сессий разом, поэтому плееры монтируются
 * по одному: подъём ячейка показывает сама. При смене отображения плеер камеры,
 * которая есть и в новом отображении, не выключается: его ячейка остаётся в DOM
 * на прежнем месте списка и лишь получает новое место в сетке (gridArea), поток
 * и <video> не пересоздаются. Поднимаются только новые, снимаются только лишние.
 * Уход со страницы разбирает всё разом: смотреть уже некому.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlayerStats, PlayerStatus } from '../../components/webrtc/useWebRTCPlayer';
import { Icon } from '../../app/Icons';
import { CellPlayer } from './CellPlayer';
import { SurroundCell } from './SurroundCell';
import { faultOf, resolveStream, useOfflineSince, type WallSource } from './sources';
import type { Grid, LayoutState } from './model';
import './wall.css';

// Пауза между подъёмом соседних плееров
const OPEN_STEP_MS = 200;

interface FCellKey {
    key: string;
    sourceId: string;
}

/** Ход смены отображения: подъём новых плееров по одному; уцелевшие с прежнего отображения уже в счёте */
export interface WallLoad {
    done: number;
    total: number;
}


export interface WallProps {
    grid: Grid;
    layout: LayoutState;
    sources: WallSource[];
    /** Меняется при смене отображения: сброс раскрытия, ход подъёма новых плееров.
     *  Плееры камер, что есть и в новом отображении, остаются поднятыми и переезжают */
    switchKey: string;
    /** Растёт, когда нужно пересоздать все плееры заново (кнопка «Обновить поток») */
    reloadKey?: number;
    /** ownerId — источник, чьё устройство держит поток; для второго потока 360 это основной */
    signalingUrlOf: (sourceId: string, ownerId?: string) => string;
    deviceTimeMs: number | null;
    /** Редактор разрешает перетаскивание, выбор и очистку ячеек */
    editable?: boolean;
    selectedCell?: string | null;
    onSelectCell?: (cellId: string) => void;
    /** Тач-раскладка: источник выбран в списке, нажатие по ячейке ставит его */
    pickedSource?: string | null;
    onPickPlace?: (cellId: string) => void;
    onAssign?: (cellId: string, sourceId: string) => void;
    onSwap?: (from: string, to: string) => void;
    onRemove?: (cellId: string) => void;
    onCorrectedChange?: (cameraId: string, value: boolean) => void;
    onDetectionsChange?: (cameraId: string, value: boolean) => void;
    /** Смена потока просмотра баджем в ячейке */
    onStreamChange?: (cameraId: string, streamKey: string) => void;
    onSurroundManualChange?: (value: boolean) => void;
    /** Видимый режим ячейки 360 при двойном выводе; уходит в раскладку */
    onSurroundViewModeChange?: (value: 'top' | 'surround') => void;
    /** Сколько ячеек реально в эфире из занятых */
    onLiveCount?: (live: number, total: number) => void;
    /** Идёт смена отображения (null — стена собрана): экран на это время не даёт сменить его снова */
    onLoadChange?: (load: WallLoad | null) => void;
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
    reloadKey = 0,
    signalingUrlOf,
    deviceTimeMs,
    editable = false,
    selectedCell = null,
    onSelectCell,
    pickedSource = null,
    onPickPlace,
    onAssign,
    onSwap,
    onRemove,
    onCorrectedChange,
    onDetectionsChange,
    onStreamChange,
    onSurroundManualChange,
    onSurroundViewModeChange,
    onLiveCount,
    onLoadChange,
    onCellStats,
    cellControls = 'all',
    correctionLinks = {},
    correctionRequest = null,
    onCorrectionBusy,
}: WallProps) {
    const [mounted, setMounted] = useState<string[]>([]);
    // От смены отображения до подъёма всех его новых плееров
    const [loading, setLoading] = useState(false);
    // Стена закрыта полоской: только когда в новом отображении нет ни одного живого плеера,
    // иначе уцелевшие видны и просто переезжают
    const [covered, setCovered] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [statuses, setStatuses] = useState<Record<string, PlayerStatus>>({});
    const [dragOver, setDragOver] = useState<string | null>(null);
    const [dragSource, setDragSource] = useState<string | null>(null);

    // Пишется из жестов 360 синхронно: dragstart приходит сразу за pointerdown
    const gestureLockRef = useRef(false);

    const mountedRef = useRef<string[]>([]);
    mountedRef.current = mounted;
    const switchRef = useRef(`${switchKey}|${reloadKey}`);
    const wallRef = useRef<HTMLDivElement>(null);

    const sourceOf = useCallback(
        (id: string | undefined) => (id ? sources.find(s => s.id === id) : undefined),
        [sources],
    );

    const offlineSince = useOfflineSince(sources);
    const offlineSinceOf = (source: WallSource) =>
        (source.offline && source.deviceId ? offlineSince.get(source.deviceId) ?? null : null);

    // Ключ закрепляется за плеером и переезжает вместе с ним: и React, и
    // очередь подъёма видят один и тот же плеер на новом месте. Раздавать
    // ключи по порядку нельзя — при двух ячейках с одной камерой порядок
    // меняется от любой перестановки, и плееры пересоздаются
    const keysRef = useRef({ byCell: new Map<string, FCellKey>(), seq: 0, reload: reloadKey });

    const cellKeys = useMemo(() => {
        // Перезапуск потоков: прежние ключи забываются, все плееры получают новые
        if (keysRef.current.reload !== reloadKey) {
            keysRef.current.reload = reloadKey;
            keysRef.current.byCell = new Map();
        }
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
    }, [grid, layout.cells, reloadKey]);

    // Занятые ячейки текущей сетки, в порядке слева направо сверху вниз
    const target = useMemo(
        () => grid.cells
            .filter(cell => Boolean(layout.cells[cell.id]))
            .map(cell => cellKeys[cell.id]),
        [grid, layout.cells, cellKeys],
    );

    // Порядок ячеек в DOM: уцелевшие остаются на своих местах списка, новые добавляются в конец.
    // Место ячейки на экране задаёт gridArea, поэтому порядок DOM для глаза не важен, а
    // перестановка узлов вынимает <video> из документа — этого плеерам не нужно
    const orderRef = useRef<string[]>([]);

    const orderedCells = useMemo(() => {
        const byKey = new Map(grid.cells.map(cell => [cellKeys[cell.id], cell]));
        const kept = orderRef.current.filter(key => byKey.has(key));
        const keptSet = new Set(kept);
        const added = grid.cells.map(cell => cellKeys[cell.id]).filter(key => !keptSet.has(key));

        orderRef.current = [...kept, ...added];
        return orderRef.current.map(key => byKey.get(key)!);
    }, [grid, cellKeys]);

    // Ячейка 360 применяет настройки раскладки (режим вида, орбита) только при подъёме.
    // Поэтому живую ячейку оставляем, лишь если новое отображение просит то же, что уже
    // стоит на камере (включая правки пользователя в самой ячейке); иначе эпоха растёт,
    // и ячейка поднимается заново с настройками нового отображения
    const surroundKnownRef = useRef({ viewMode: layout.surround?.viewMode, manual: layout.surround?.manual });
    const surroundEpochRef = useRef(0);
    const surroundEpoch = useMemo(() => {
        const want = { viewMode: layout.surround?.viewMode, manual: layout.surround?.manual };
        const known = surroundKnownRef.current;
        if (want.viewMode !== known.viewMode || want.manual !== known.manual) surroundEpochRef.current += 1;
        surroundKnownRef.current = want;
        return surroundEpochRef.current;
        // Только при смене отображения: правки внутри него эпоху не двигают
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [switchKey]);

    // ─── Смена отображения ──────────────────────────────────────

    const targetRef = useRef(target);
    targetRef.current = target;

    // Layout-эффект: полоска должна встать до отрисовки новой стены
    useLayoutEffect(() => {
        const signature = `${switchKey}|${reloadKey}`;
        if (switchRef.current === signature) return;
        switchRef.current = signature;

        // Раскрытие принадлежит прежней сетке: ячейка с тем же id есть почти в
        // каждой, и без сброса любое следующее отображение оставалось бы одной
        // ячейкой на весь экран — на панели из этого не выйти без клавиатуры
        setExpanded(null);

        // Плееры камер, которые есть и в новом отображении, остаются поднятыми и переезжают
        // на новое место; ждать нужно только новых. Лишние уходят из DOM вместе со своими
        // ячейками, а из списка поднятых их снимает эффект ниже
        const pending = targetRef.current.filter(key => !mountedRef.current.includes(key));
        setLoading(pending.length > 0);
        setCovered(pending.length > 0 && pending.length === targetRef.current.length);
    }, [switchKey, reloadKey]);

    // ─── Подъём по одному ───────────────────────────────────────

    useEffect(() => {
        // Ячейки, которых в цели больше нет, снимаем сразу
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
    }, [target, mounted]);

    // ─── Ход смены отображения ──────────────────────────────────

    // Загрузка кончается, когда поднялись все плееры нового отображения; подключение
    // камер сюда не входит: мёртвая камера не должна держать экран заблокированным
    useEffect(() => {
        if (!loading) return;
        if (target.every(key => mounted.includes(key))) {
            setLoading(false);
            setCovered(false);
        }
    }, [loading, target, mounted]);

    const loaded = target.filter(key => mounted.includes(key)).length;

    useEffect(() => {
        onLoadChange?.(loading ? { done: loaded, total: target.length } : null);
    }, [loading, loaded, target.length, onLoadChange]);

    // ─── Счётчик живых сессий ───────────────────────────────────

    useEffect(() => {
        const live = target.filter(key => statuses[key] === 'streaming').length;
        onLiveCount?.(live, target.length);
    }, [statuses, target, onLiveCount]);

    const setStatus = useCallback((key: string, status: PlayerStatus) => {
        setStatuses(prev => (prev[key] === status ? prev : { ...prev, [key]: status }));
    }, []);

    // ─── Раскрытие ячейки ───────────────────────────────────────

    // Положение ячеек до раскрытия или сворачивания и сама ячейка, которая переезжает
    const rectsBeforeRef = useRef<Map<string, DOMRect> | null>(null);
    const movingRef = useRef<string | null>(null);

    const rememberRects = (movingCell: string) => {
        const rects = new Map<string, DOMRect>();
        wallRef.current?.querySelectorAll<HTMLElement>('[data-cell]').forEach(el => {
            rects.set(el.dataset.cell!, el.getBoundingClientRect());
        });
        rectsBeforeRef.current = rects;
        movingRef.current = movingCell;
    };

    // Ячейка уже стоит на новом месте; transform возвращает её на прежнее и плавно снимается:
    // кадр не перекладывается заново, переезд идёт на композиторе
    useLayoutEffect(() => {
        const before = rectsBeforeRef.current;
        const id = movingRef.current;
        rectsBeforeRef.current = null;
        movingRef.current = null;
        if (!before || !id || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        const el = wallRef.current?.querySelector<HTMLElement>(`[data-cell="${id}"]`);
        const first = before.get(id);
        if (!el || !first) return;
        const last = el.getBoundingClientRect();
        if (!last.width || !last.height) return;

        // Пока ячейка в пути, она поверх соседей, которые растворяются или проявляются
        el.style.zIndex = '3';
        const move = el.animate([
            {
                transformOrigin: '0 0',
                transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`,
            },
            { transformOrigin: '0 0', transform: 'none' },
        ], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
        const settle = () => { el.style.zIndex = ''; };
        move.onfinish = settle;
        move.oncancel = settle;
    }, [expanded]);

    useEffect(() => {
        if (!expanded) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            rememberRects(expanded);
            setExpanded(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [expanded]);

    // Кнопка ячейки и двойной клик — одно действие: раскрыть или свернуть
    const toggleExpanded = (cellId: string) => {
        rememberRects(cellId);
        setExpanded(prev => (prev === cellId ? null : cellId));
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

        if (source.kind === 'virtual' && !source.active && !source.offline) {
            return <div className="cell-msg"><b>{source.name}</b>модуль не запущен</div>;
        }

        if (source.kind === 'camera' && source.viewStreams.length === 0) {
            return <div className="cell-msg"><b>{source.name}</b>нет потока для просмотра</div>;
        }

        // Плеер ещё не поднят: ход виден в планке экрана, в самой ячейке — пусто
        if (!mounted.includes(cellKeys[cellId])) return null;

        if (source.producer === 'birdview') {
            return (
                <SurroundCell
                    key={`${sourceId}-${surroundEpoch}`}
                    offlineSince={offlineSinceOf(source)}
                    streamId={sourceId}
                    name={source.name}
                    signalingUrl={signalingUrlOf(sourceId)}
                    overlays={layout.overlays}
                    deviceTimeMs={deviceTimeMs}
                    collectStats={(!expanded || expanded === cellId)
                        && (layout.overlays.stats || cellId === selectedCell)}
                    secondary={source.secondary
                        ? { ...source.secondary, signalingUrl: signalingUrlOf(source.secondary.streamId, sourceId) }
                        : null}
                    initialViewMode={layout.surround?.viewMode}
                    onViewModeChange={mode => {
                        surroundKnownRef.current = { ...surroundKnownRef.current, viewMode: mode };
                        onSurroundViewModeChange?.(mode);
                    }}
                    initialManual={layout.surround?.manual}
                    onManualChange={manual => {
                        surroundKnownRef.current = { ...surroundKnownRef.current, manual };
                        onSurroundManualChange?.(manual);
                    }}
                    onGestureLock={locked => { gestureLockRef.current = locked; }}
                    onStatus={status => setStatus(cellKeys[cellId], status)}
                    onStats={cellId === selectedCell ? onCellStats : undefined}
                />
            );
        }

        const { key } = resolveStream(source, layout.streams[sourceId]);

        return (
            <CellPlayer
                key={sourceId}
                offlineSince={offlineSinceOf(source)}
                fault={faultOf(source, key)}
                cameraId={sourceId}
                cameraName={source.name}
                signalingUrl={signalingUrlOf(sourceId)}
                streamKey={key}
                streams={source.viewStreams}
                onStreamChange={onStreamChange && (streamKey => onStreamChange(sourceId, streamKey))}
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
                className={`wall${expanded ? ' is-expanded' : ''}${pickedSource ? ' is-picking' : ''}`}
                ref={wallRef}
                style={{
                    // minmax(0,1fr): иначе трек не уже своего содержимого — стена
                    // вылезает за экран, а пустые ячейки схлопываются в полоски
                    gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
                }}
            >
                {orderedCells.map(cell => {
                    const sourceId = layout.cells[cell.id];
                    const key = cellKeys[cell.id];
                    const source = sourceOf(sourceId);
                    const empty = !sourceId;
                    const broken = Boolean(sourceId) && (!source
                        || (source.kind === 'virtual' && !source.active && !source.offline)
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
                                pickedSource ? (empty ? 'is-free' : 'is-busy') : '',
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
                            onClick={event => {
                                // Выбран источник — нажатие ставит его в ячейку;
                                // stopPropagation не даёт внешнему сбросу снять выбор
                                if (pickedSource && onPickPlace) {
                                    event.stopPropagation();
                                    onPickPlace(cell.id);
                                    return;
                                }
                                onSelectCell?.(cell.id);
                            }}
                            onDoubleClick={() => toggleExpanded(cell.id)}
                        >
                            {renderBody(cell.id)}

                            {pickedSource && (
                                <div className="cell-pick">
                                    <span>{empty ? 'Поставить в эту ячейку' : 'Заменить эту ячейку'}</span>
                                </div>
                            )}

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
                                        data-tip={expanded === cell.id ? 'Свернуть ячейку' : 'Развернуть ячейку'}
                                        aria-label={expanded === cell.id ? 'Свернуть ячейку' : 'Развернуть ячейку'}
                                        onClick={event => { event.stopPropagation(); toggleExpanded(cell.id); }}
                                    >
                                        <Icon name={expanded === cell.id ? 'unfull' : 'full'} />
                                    </button>
                                    {editable && onRemove && (
                                        <button
                                            className="cell-btn"
                                            data-tip="Убрать из ячейки" aria-label="Убрать из ячейки"
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

            {covered && (
                <div className="wall-switching" role="status" aria-label="Переключение">
                    {/* Та же полоска, что у сплэша приложения (index.html) */}
                    <div className="boot-bar" />
                </div>
            )}
        </div>
    );
}
