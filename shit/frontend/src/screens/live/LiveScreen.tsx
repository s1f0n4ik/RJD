/**
 * Отображение — редактор сеток.
 *
 * Слева стена, справа три блока: сохранённые сетки, выбранная ячейка и
 * источники. Раскладка, расстановка камер, выбранные потоки, коррекция и
 * рамки — всё это одно отображение, которое сохраняется целиком и целиком же
 * применяется в трансляции.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Switch } from '../../app/Modal';
import { Select } from '../../app/Select';
import { Icon } from '../../app/Icons';
import { useDeviceClock } from '../../app/useDeviceClock';
import { useLayouts, type SavedLayout } from '../../hooks/Layouts';
import { api } from '../../services/api';
import { signalingWsUrl } from '../../services/devices';
import { wsUrl } from '../../utils/constants';
import { isProbeCamera } from '../../utils/probeFilter';
import type { CPPCamera, VirtualStream } from '../../types';
import type { PlayerStats } from '../../components/webrtc/useWebRTCPlayer';
import { Wall } from './Wall';
import { FreeGridModal } from './FreeGridModal';
import { cameraToWallSource, resolveStream, virtualToWallSource, type WallSource } from './sources';
import {
    emptyLayout,
    layoutFromSaved,
    layoutToSaved,
    presetOf,
    PRESETS,
    type Grid,
    type LayoutState,
} from './model';
import './live.css';

// Опрос источников: пропажа устройства и смена статусов видны без перезагрузки
const SOURCES_POLL_MS = 10_000;

const LAST_LAYOUT_KEY = 'live.layout';

function gridLabel(grid: Grid): string {
    const preset = presetOf(grid);
    if (preset) return preset;
    return `${grid.rows}×${grid.cols} произв.`;
}

function num(value: number | null | undefined, digits: number): string {
    return value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ',');
}

export default function LiveScreen() {
    const navigate = useNavigate();
    const { layouts, loading, loadError, opError, save, remove } = useLayouts();
    const { unixMs } = useDeviceClock();

    const [cameras, setCameras] = useState<CPPCamera[]>([]);
    const [virtual, setVirtual] = useState<VirtualStream[]>([]);
    const [sourcesError, setSourcesError] = useState('');

    const [layout, setLayout] = useState<LayoutState>(() => emptyLayout());
    // Снимок сохранённого состояния: с ним сравниваем, чтобы понять «правлено»
    const [snapshot, setSnapshot] = useState('');
    const [switchKey, setSwitchKey] = useState('init');
    const switchSeq = useRef(0);
    const initialized = useRef(false);

    const [selectedCell, setSelectedCell] = useState<string | null>(null);
    const [selectedSource, setSelectedSource] = useState<string | null>(null);
    const [counts, setCounts] = useState({ live: 0, total: 0 });
    const [cellStats, setCellStats] = useState<PlayerStats | null>(null);

    const [overlaysOpen, setOverlaysOpen] = useState(false);
    const [freeGridOpen, setFreeGridOpen] = useState(false);
    const [saveName, setSaveName] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    // Действие, отложенное до ответа на вопрос о несохранённых правках
    const [pending, setPending] = useState<(() => void) | null>(null);
    // Действие, которое ждёт конца сохранения через модалку имени
    const afterSaveRef = useRef<(() => void) | null>(null);
    const [toast, setToast] = useState('');
    // Закрытие помнит причину: появится другая — предупреждение вернётся
    const [dismissed, setDismissed] = useState('');

    const dirty = snapshot !== '' && JSON.stringify(layout) !== snapshot;
    const problem = loadError || sourcesError || opError;

    // ─── Источники ──────────────────────────────────────────────

    useEffect(() => {
        let alive = true;

        const load = async () => {
            try {
                const { cameras: list, virtual: streams } = await api.getSources();
                if (!alive) return;
                setCameras(list.filter(camera => !isProbeCamera(camera.id)));
                setVirtual(streams);
                setSourcesError('');
            } catch (error) {
                if (!alive) return;
                setSourcesError(error instanceof Error ? error.message : 'Ошибка загрузки источников');
            }
        };

        load();
        const timer = window.setInterval(load, SOURCES_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);

    const sources: WallSource[] = useMemo(() => [
        ...cameras.map(cameraToWallSource),
        ...virtual.map(stream => virtualToWallSource(
            stream,
            id => cameras.find(camera => camera.id === id)?.display_name || id,
        )),
    ], [cameras, virtual]);

    const signalingUrlOf = useCallback((sourceId: string) => {
        const owner = sources.find(source => source.id === sourceId)?.deviceId;
        return owner ? signalingWsUrl(owner, `/client/${sourceId}`) : wsUrl(`/signaling/client/${sourceId}`);
    }, [sources]);

    // ─── Загрузка отображения ───────────────────────────────────

    const applyLayout = useCallback((saved: SavedLayout | null) => {
        const next = saved ? layoutFromSaved(saved) : emptyLayout();
        switchSeq.current += 1;
        setLayout(next);
        setSnapshot(JSON.stringify(next));
        setSwitchKey(`${next.name || 'new'}#${switchSeq.current}`);
        setSelectedCell(null);
        setSelectedSource(null);
        setCellStats(null);
        if (saved) localStorage.setItem(LAST_LAYOUT_KEY, saved.name);
    }, []);

    // Вход открывает последнее правившееся отображение, иначе первое из списка
    useEffect(() => {
        if (loading || initialized.current) return;
        initialized.current = true;
        const lastName = localStorage.getItem(LAST_LAYOUT_KEY);
        const found = layouts.find(item => item.name === lastName) ?? layouts[0] ?? null;
        applyLayout(found);
    }, [loading, layouts, applyLayout]);

    // Правки не должны теряться молча при закрытии вкладки
    useEffect(() => {
        if (!dirty) return;
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [dirty]);

    // Действие, которое может потерять правки, спрашивает разрешения
    const guard = useCallback((action: () => void) => {
        if (dirty) setPending(() => action);
        else action();
    }, [dirty]);

    // Уход по рельсе перехватываем на всплытии клика: BrowserRouter без
    // data-роутера блокировщика переходов не даёт
    useEffect(() => {
        if (!dirty) return;

        const onClick = (event: MouseEvent) => {
            if (event.defaultPrevented || event.button !== 0) return;
            const link = (event.target as HTMLElement | null)?.closest('a[href]');
            if (!(link instanceof HTMLAnchorElement)) return;
            if (!link.closest('.rail')) return;

            const url = new URL(link.href);
            if (url.pathname === window.location.pathname) return;

            event.preventDefault();
            const to = url.pathname.replace(/^\/new/, '') || '/';
            guard(() => navigate(to));
        };

        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, [dirty, guard, navigate]);

    // ─── Правки отображения ─────────────────────────────────────

    const assign = (cellId: string, sourceId: string) => {
        setLayout(prev => ({ ...prev, cells: { ...prev.cells, [cellId]: sourceId } }));
    };

    const removeFromCell = (cellId: string) => {
        setLayout(prev => {
            const cells = { ...prev.cells };
            delete cells[cellId];
            return { ...prev, cells };
        });
    };

    const swap = (from: string, to: string) => {
        setLayout(prev => {
            const cells = { ...prev.cells };
            const a = cells[from];
            const b = cells[to];
            if (b) cells[from] = b; else delete cells[from];
            if (a) cells[to] = a; else delete cells[to];
            return { ...prev, cells };
        });
    };

    // Следующая свободная ячейка: расстановка идёт подряд, без лишних кликов
    const nextEmptyCell = (afterId: string): string | null => {
        const ids = layout.grid.cells.map(cell => cell.id);
        const start = ids.indexOf(afterId) + 1;
        const ordered = [...ids.slice(start), ...ids.slice(0, start)];
        return ordered.find(id => !layout.cells[id]) ?? null;
    };

    const handleLiveCount = useCallback((live: number, total: number) => {
        setCounts(prev => (prev.live === live && prev.total === total ? prev : { live, total }));
    }, []);

    const handleCellClick = (cellId: string) => {
        if (selectedSource) {
            assign(cellId, selectedSource);
            setSelectedSource(null);
            setSelectedCell(nextEmptyCell(cellId));
            return;
        }
        setSelectedCell(cellId);
        setCellStats(null);
    };

    const handleSourceClick = (sourceId: string) => {
        if (selectedCell) {
            assign(selectedCell, sourceId);
            setSelectedCell(nextEmptyCell(selectedCell));
            return;
        }
        setSelectedSource(prev => (prev === sourceId ? null : sourceId));
    };

    const applyGrid = (grid: Grid) => {
        // Смена раскладки — повод разобрать стену: сессии закрываются под плашкой
        switchSeq.current += 1;
        setLayout(prev => ({ ...prev, grid }));
        setSwitchKey(`${layout.name || 'new'}#${switchSeq.current}`);
        setSelectedCell(null);
    };

    const setOverlay = (key: 'name' | 'time', value: boolean) => {
        setLayout(prev => ({ ...prev, overlays: { ...prev.overlays, [key]: value } }));
    };

    const setCorrected = useCallback((cameraId: string, value: boolean) => {
        setLayout(prev => ({ ...prev, corrections: { ...prev.corrections, [cameraId]: value } }));
    }, []);

    const setDetections = useCallback((cameraId: string, value: boolean) => {
        setLayout(prev => ({ ...prev, detections: { ...prev.detections, [cameraId]: value } }));
    }, []);

    const setSurroundManual = useCallback((value: boolean) => {
        setLayout(prev => ({
            ...prev,
            surround: { viewMode: prev.surround?.viewMode ?? 'top', manual: value },
        }));
    }, []);

    const setCellStream = (cameraId: string, streamKey: string) => {
        setLayout(prev => ({ ...prev, streams: { ...prev.streams, [cameraId]: streamKey } }));
    };

    // ─── Сохранение ─────────────────────────────────────────────

    const persist = async (name: string) => {
        const next = { ...layout, name };
        const ok = await save(layoutToSaved(next, Date.now()));
        if (!ok) return;
        setLayout(next);
        setSnapshot(JSON.stringify(next));
        localStorage.setItem(LAST_LAYOUT_KEY, name);
        setSaveName(null);
        setToast(`Отображение «${name}» сохранено`);
        window.setTimeout(() => setToast(''), 3000);

        const queued = afterSaveRef.current;
        afterSaveRef.current = null;
        queued?.();
    };

    const handleDelete = async () => {
        const name = layout.name;
        setConfirmDelete(false);
        if (!name) return;
        const ok = await remove(name);
        if (!ok) return;
        localStorage.removeItem(LAST_LAYOUT_KEY);
        applyLayout(layouts.find(item => item.name !== name) ?? null);
    };

    const goTranslation = () => {
        const path = layout.name ? `/translation/${encodeURIComponent(layout.name)}` : '/translation';
        window.location.href = path;
    };

    // ─── Данные для правой колонки ──────────────────────────────

    const cellSourceId = selectedCell ? layout.cells[selectedCell] : undefined;
    const cellSource = sources.find(source => source.id === cellSourceId);
    const cellIndex = selectedCell ? layout.grid.cells.findIndex(cell => cell.id === selectedCell) + 1 : 0;
    const resolved = resolveStream(cellSource, cellSourceId ? layout.streams[cellSourceId] : undefined);

    const cameraSources = sources.filter(source => source.kind === 'camera');
    const virtualSources = sources.filter(source => source.kind === 'virtual');

    const cellOfSource = (sourceId: string): string | null => {
        const found = Object.entries(layout.cells).find(([, id]) => id === sourceId);
        if (!found) return null;
        const index = layout.grid.cells.findIndex(cell => cell.id === found[0]);
        return index >= 0 ? `яч. ${index + 1}` : 'вне сетки';
    };

    const currentPreset = presetOf(layout.grid);

    const renderSourceRow = (source: WallSource) => {
        const place = cellOfSource(source.id);
        const color = source.offline || !source.active ? 'var(--err)' : 'var(--ok)';
        // Камеру без потока с назначением view класть в ячейку некуда
        const unusable = source.kind === 'camera' && source.viewStreams.length === 0;

        return (
            <button
                key={source.id}
                className={`row-item${selectedSource === source.id ? ' is-sel' : ''}${unusable ? ' is-dim' : ''}`}
                onClick={() => { if (!unusable) handleSourceClick(source.id); }}
                draggable={!unusable}
                onDragStart={event => event.dataTransfer.setData('text/plain', `source:${source.id}`)}
            >
                <span className="chip-col" style={{ background: color }} />
                <span className="nm">{source.name}</span>
                <span
                    className="num"
                    style={place === 'вне сетки' ? { color: 'var(--warn)' } : undefined}
                    title={unusable ? 'Ни один поток камеры не назначен на просмотр' : undefined}
                >
                    {unusable ? 'нет потока' : place ?? '—'}
                </span>
            </button>
        );
    };

    return (
        <section className="screen live">
            <div className="toolbar">
                <span className="eyebrow" style={{ marginRight: 4 }}>Раскладка</span>
                {PRESETS.map(preset => (
                    <button
                        key={preset.key}
                        className={`tool${currentPreset === preset.key ? ' is-on' : ''}`}
                        onClick={() => applyGrid(preset.grid)}
                    >
                        {preset.label}
                    </button>
                ))}
                <button
                    className={`tool${currentPreset === null ? ' is-on' : ''}`}
                    onClick={() => setFreeGridOpen(true)}
                >
                    Произвольная…
                </button>

                <div className="tbar-sep" />

                <div className="live-pop">
                    <button
                        className={`tool${overlaysOpen ? ' is-on' : ''}`}
                        onClick={() => setOverlaysOpen(value => !value)}
                    >
                        Наложения
                    </button>
                    {overlaysOpen && (
                        <div className="live-pop-body">
                            <Switch on={layout.overlays.name} onToggle={value => setOverlay('name', value)}>Имя камеры поверх кадра</Switch>
                            <Switch on={layout.overlays.time} onToggle={value => setOverlay('time', value)}>Время и дата</Switch>
                        </div>
                    )}
                </div>

                <div className="zoom">
                    <span className={`pill${counts.live < counts.total ? ' warn' : ''}`}>
                        <span className="dot" />
                        {counts.live} из {counts.total} в эфире
                    </span>
                    <button onClick={() => guard(goTranslation)}>Режим трансляции</button>
                </div>
            </div>

            {problem && dismissed !== problem && (
                <div className="banner live-banner">
                    <Icon name="warn" size={16} />
                    {problem}
                    <button
                        className="icon-btn"
                        style={{ marginLeft: 'auto', flexShrink: 0 }}
                        onClick={() => setDismissed(problem)}
                        aria-label="Скрыть предупреждение"
                    >
                        <Icon name="x" size={13} />
                    </button>
                </div>
            )}

            <div className="live-body">
                <Wall
                    grid={layout.grid}
                    layout={layout}
                    sources={sources}
                    switchKey={switchKey}
                    signalingUrlOf={signalingUrlOf}
                    deviceTimeMs={unixMs}
                    editable
                    selectedCell={selectedCell}
                    onSelectCell={handleCellClick}
                    onAssign={assign}
                    onSwap={swap}
                    onRemove={removeFromCell}
                    onCorrectedChange={setCorrected}
                    onDetectionsChange={setDetections}
                    onSurroundManualChange={setSurroundManual}
                    onLiveCount={handleLiveCount}
                    onCellStats={setCellStats}
                    cellControls={false}
                />

                <aside className="settings">
                    <div className="sect">
                        <span className="eyebrow">
                            Сохранённые сетки
                            {dirty && <span className="live-dot" title="Есть несохранённые правки" />}
                        </span>

                        {layouts.map(item => (
                            <button
                                key={item.name}
                                className={`row-item${item.name === layout.name ? ' is-sel' : ''}`}
                                onClick={() => guard(() => applyLayout(item))}
                            >
                                <span className="chip-col" style={{ background: 'var(--acc)' }} />
                                <span className="nm">{item.name}</span>
                                <span className="num">{gridLabel(layoutFromSaved(item).grid)}</span>
                            </button>
                        ))}

                        <div className="live-row">
                            <button className="btn btn--sm" style={{ flex: 1 }} onClick={() => setSaveName(layout.name)}>
                                Сохранить как…
                            </button>
                            <button
                                className="btn btn--sm btn--err"
                                disabled={!layout.name}
                                onClick={() => setConfirmDelete(true)}
                            >
                                <Icon name="trash" />
                            </button>
                        </div>
                    </div>

                    <div className="sect">
                        <span className="eyebrow">
                            {selectedCell
                                ? `Ячейка ${cellIndex}${cellSource ? ` — ${cellSource.name}` : ''}`
                                : 'Ячейка не выбрана'}
                        </span>

                        {cellSource?.kind === 'camera' && (
                            <>
                                <div className="live-field">
                                    <label>Поток</label>
                                    <Select
                                        value={resolved.key ?? ''}
                                        options={cellSource.viewStreams.map(stream => ({
                                            value: stream.key,
                                            label: stream.label,
                                        }))}
                                        onChange={value => setCellStream(cellSource.id, value)}
                                        placeholder="нет смотрибельных потоков"
                                    />
                                </div>

                                <div className="field">
                                    <label>Задержка</label>
                                    <input className="inp" value={num(cellStats?.rttMs, 0)} readOnly />
                                    <span className="unit">мс</span>
                                </div>
                                <div className="field">
                                    <label>Потерь пакетов</label>
                                    <input className="inp" value={num(cellStats?.lossPct, 2)} readOnly />
                                    <span className="unit">%</span>
                                </div>

                                <div className="live-switches">
                                    {cellSource.hasNeural && (
                                        <Switch on={Boolean(layout.detections[cellSource.id])} onToggle={value => setDetections(cellSource.id, value)}>Рамки обнаружений</Switch>
                                    )}
                                    {cellSource.hasBirdview && (
                                        <Switch on={Boolean(layout.corrections[cellSource.id])} onToggle={value => setCorrected(cellSource.id, value)}>Коррекция дисторсии</Switch>
                                    )}
                                </div>
                            </>
                        )}
                    </div>

                    <div className="sect">
                        <span className="eyebrow">Источники · камеры</span>
                        {cameraSources.map(renderSourceRow)}
                    </div>

                    {virtualSources.length > 0 && (
                        <div className="sect">
                            <span className="eyebrow">Источники · собранные потоки</span>
                            {virtualSources.map(renderSourceRow)}
                        </div>
                    )}
                </aside>
            </div>

            {toast && <div className="live-toast">{toast}</div>}

            {freeGridOpen && (
                <FreeGridModal
                    grid={layout.grid}
                    onClose={() => setFreeGridOpen(false)}
                    onApply={grid => { applyGrid(grid); setFreeGridOpen(false); }}
                />
            )}

            {saveName !== null && (
                <Modal
                    title="Сохранить отображение"
                    onClose={() => setSaveName(null)}
                    footer={
                        <>
                            <button className="btn" onClick={() => setSaveName(null)}>Отмена</button>
                            <button
                                className="btn btn--acc"
                                disabled={!saveName.trim()}
                                onClick={() => void persist(saveName.trim())}
                            >
                                {layouts.some(item => item.name === saveName.trim()) ? 'Перезаписать' : 'Сохранить'}
                            </button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <div className="live-field">
                            <label>Название</label>
                            <input
                                className="inp inp--wide"
                                value={saveName}
                                autoFocus
                                onChange={event => setSaveName(event.target.value)}
                                placeholder="Обход состава"
                            />
                        </div>
                        {layouts.some(item => item.name === saveName.trim()) && saveName.trim() && (
                            <p className="hint is-err">Отображение с таким названием уже есть — оно будет перезаписано.</p>
                        )}
                    </div>
                </Modal>
            )}

            {confirmDelete && (
                <Modal
                    title="Удалить отображение"
                    onClose={() => setConfirmDelete(false)}
                    footer={
                        <>
                            <button className="btn" onClick={() => setConfirmDelete(false)}>Отмена</button>
                            <button className="btn btn--err" onClick={() => void handleDelete()}>Удалить</button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <p>Отображение «{layout.name}» будет удалено без возможности вернуть.</p>
                    </div>
                </Modal>
            )}

            {pending && (
                <Modal
                    title="Несохранённые правки"
                    onClose={() => setPending(null)}
                    footer={
                        <>
                            <button className="btn" onClick={() => setPending(null)}>Отмена</button>
                            <button
                                className="btn"
                                onClick={() => { const action = pending; setPending(null); action(); }}
                            >
                                Не сохранять
                            </button>
                            <button
                                className="btn btn--acc"
                                onClick={async () => {
                                    const action = pending;
                                    setPending(null);
                                    // Безымянное отображение сперва спросит имя,
                                    // а действие продолжится после сохранения
                                    if (!layout.name) {
                                        afterSaveRef.current = action;
                                        setSaveName('');
                                        return;
                                    }
                                    await persist(layout.name);
                                    action();
                                }}
                            >
                                Сохранить
                            </button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <p>В отображении есть правки, которых нет в сохранённом файле. Трансляция читает файл, а не экран.</p>
                    </div>
                </Modal>
            )}
        </section>
    );
}
