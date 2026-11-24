/**
 * Отображение — редактор сеток.
 *
 * Слева стена, справа три блока: сохранённые сетки, выбранная ячейка и
 * источники. Раскладка, расстановка камер, выбранные потоки, коррекция и
 * рамки — всё это одно отображение, которое сохраняется целиком и целиком же
 * применяется в трансляции.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Switch } from '../../app/Modal';
import { useToast } from '../../app/Toast';
import { Select } from '../../app/Select';
import { Icon } from '../../app/Icons';
import { useDeviceClock } from '../../app/useDeviceClock';
import { lastLayoutKey, useLayouts, type SavedLayout } from '../../hooks/Layouts';
import { api } from '../../services/api';
import { signalingWsUrl } from '../../services/devices';
import { wsUrl } from '../../utils/constants';
import { isProbeCamera } from '../../utils/probeFilter';
import type { CPPCamera, VirtualStream } from '../../types';
import type { PlayerStats } from '../../components/webrtc/useWebRTCPlayer';
import { Wall } from './Wall';
import { FreeGridModal } from './FreeGridModal';
import { cameraToWallSource, resolveStream, virtualToWallSource, type WallSource } from './sources';
import { useCorrectionLinks } from './useCorrectionLinks';
import {
    emptyLayout,
    layoutFromSaved,
    layoutToSaved,
    presetOf,
    PRESETS,
    type Grid,
    type LayoutState,
    type Overlays,
} from './model';
import './live.css';
import { useFlash } from '../../app/motion';
import { useNavigationGuard } from '../../app/use-navigation-guard';

// Опрос источников: пропажа устройства и смена статусов видны без перезагрузки
const SOURCES_POLL_MS = 10_000;

function gridLabel(grid: Grid): string {
    const preset = presetOf(grid);
    if (preset) return preset;
    return `${grid.rows}×${grid.cols}`;
}

function num(value: number | null | undefined, digits: number): string {
    return value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ',');
}

export default function LiveScreen() {
    const { layouts, loading, profileId, context, blocked, loadError, opError, save, remove } = useLayouts();
    const correctionLinks = useCorrectionLinks();
    const { unixMs } = useDeviceClock();

    const [cameras, setCameras] = useState<CPPCamera[]>([]);
    const [virtual, setVirtual] = useState<VirtualStream[]>([]);
    const [sourceContext, setSourceContext] = useState('');
    const [sourcesError, setSourcesError] = useState('');

    const [layout, setLayout] = useState<LayoutState>(() => emptyLayout());
    // Снимок сохранённого состояния: с ним сравниваем, чтобы понять «правлено»
    const [snapshot, setSnapshot] = useState('');
    const [switchKey, setSwitchKey] = useState('init');
    const switchSeq = useRef(0);
    const initialized = useRef<string | null>(null);
    const [draftContext, setDraftContext] = useState('');

    const [selectedCell, setSelectedCell] = useState<string | null>(null);
    const [selectedSource, setSelectedSource] = useState<string | null>(null);
    const [counts, setCounts] = useState({ live: 0, total: 0 });
    const [cellStats, setCellStats] = useState<PlayerStats | null>(null);
    // Коррекция включается только с подтверждением камеры, поэтому правая
    // колонка не правит отображение сама, а просит об этом ячейку
    const [correctionRequest, setCorrectionRequest] = useState<
        { cameraId: string; enable: boolean; nonce: number } | null>(null);
    const [correctionBusy, setCorrectionBusy] = useState<Record<string, boolean>>({});
    const requestSeq = useRef(0);

    const [overlaysOpen, setOverlaysOpen] = useState(false);
    const overlaysRef = useRef<HTMLDivElement>(null);
    const [freeGridOpen, setFreeGridOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    // Имя, под которым открытое отображение лежит на сервере; пусто — ещё не сохранялось.
    // Название в layout правится свободно, а переименование делается при сохранении
    const [savedName, setSavedName] = useState('');
    const [editingName, setEditingName] = useState(false);
    const nameBackup = useRef('');
    const nameInput = useRef<HTMLInputElement>(null);
    const [creating, setCreating] = useState(false);
    // Только что добавленная строка проявляется, удаляемая — уходит; после этого строки нет
    const [freshName, setFreshName] = useState<string | null>(null);
    const [leavingName, setLeavingName] = useState<string | null>(null);
    // Имя отображения, ожидающего подтверждения удаления
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    // Действие, отложенное до ответа на вопрос о несохранённых правках
    const [pending, setPending] = useState<(() => void) | null>(null);
    const toast = useToast();
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
                setSourceContext(context);
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
    }, [context]);

    const sources: WallSource[] = useMemo(() => sourceContext !== context || blocked ? [] : [
        ...cameras.map(cameraToWallSource),
        ...virtual.map(stream => virtualToWallSource(
            stream,
            id => cameras.find(camera => camera.id === id)?.display_name || id,
        )),
    ], [cameras, virtual, sourceContext, context, blocked]);

    // Владелец ищется по ownerId: второй поток 360 в списке источников не значится
    const signalingUrlOf = useCallback((sourceId: string, ownerId: string = sourceId) => {
        const owner = sources.find(source => source.id === ownerId)?.deviceId;
        return owner ? signalingWsUrl(owner, `/client/${sourceId}`) : wsUrl(`/signaling/client/${sourceId}`);
    }, [sources]);

    // ─── Загрузка отображения ───────────────────────────────────

    const applyLayout = useCallback((saved: SavedLayout | null) => {
        const next = saved ? layoutFromSaved(saved) : emptyLayout();
        switchSeq.current += 1;
        setLayout(next);
        setDraftContext(context);
        setSnapshot(JSON.stringify(next));
        setSavedName(next.name);
        setEditingName(false);
        setSwitchKey(`${next.name || 'new'}#${switchSeq.current}`);
        setSelectedCell(null);
        setSelectedSource(null);
        setCellStats(null);
        if (saved) localStorage.setItem(lastLayoutKey(profileId), saved.name);
    }, [context, profileId]);

    // Вход открывает последнее правившееся отображение, иначе первое из списка
    useEffect(() => {
        if (loading || blocked || initialized.current === context) return;
        initialized.current = context;
        const lastName = localStorage.getItem(lastLayoutKey(profileId));
        const found = layouts.find(item => item.name === lastName) ?? layouts[0] ?? null;
        if (dirty) setPending(() => () => applyLayout(found));
        else applyLayout(found);
    }, [loading, blocked, context, profileId, layouts, applyLayout, dirty]);

    useEffect(() => {
        if (!overlaysOpen) return;
        const onDown = (event: MouseEvent) => {
            if (overlaysRef.current?.contains(event.target as Node)) return;
            setOverlaysOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [overlaysOpen]);

    // Действие, которое может потерять правки, спрашивает разрешения
    const guard = useCallback((action: () => void) => {
        if (dirty) setPending(() => action);
        else action();
    }, [dirty]);

    const { cancelNavigation } = useNavigationGuard(dirty, guard);

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

    const setOverlay = (key: keyof Overlays, value: boolean) => {
        setLayout(prev => ({ ...prev, overlays: { ...prev.overlays, [key]: value } }));
    };

    const requestCorrection = (cameraId: string, enable: boolean) => {
        requestSeq.current += 1;
        setCorrectionRequest({ cameraId, enable, nonce: requestSeq.current });
    };

    const handleCorrectionBusy = useCallback((cameraId: string, busy: boolean) => {
        setCorrectionBusy(prev => (prev[cameraId] === busy ? prev : { ...prev, [cameraId]: busy }));
    }, []);

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

    const setSurroundViewMode = useCallback((value: 'top' | 'surround') => {
        setLayout(prev => ({
            ...prev,
            surround: { viewMode: value, manual: prev.surround?.manual ?? false },
        }));
    }, []);

    const setCellStream = (cameraId: string, streamKey: string) => {
        setLayout(prev => ({ ...prev, streams: { ...prev.streams, [cameraId]: streamKey } }));
    };

    // ─── Сохранение ─────────────────────────────────────────────

    // Свободное имя с номером: «Новое отображение», «Новое отображение 2», …
    const freeName = (base: string) => {
        const taken = new Set(layouts.map(item => item.name));
        if (!taken.has(base)) return base;
        let n = 2;
        while (taken.has(`${base} ${n}`)) n += 1;
        return `${base} ${n}`;
    };

    // Название открытого отображения: пустое у ещё не сохранённого — не ошибка, имя подберётся само
    const nameTrim = layout.name.trim();
    const nameError = !nameTrim
        ? (savedName ? 'Введите название' : '')
        : layouts.some(item => item.name === nameTrim && item.name !== savedName) ? 'Такое название уже есть' : '';

    const persist = async (rawName: string) => {
        if (saving) return false;
        const name = rawName.trim() || freeName('Новое отображение');
        const next = { ...layout, name };
        setSaving(true);
        const ok = await save(layoutToSaved(next, Date.now()), draftContext);
        // Переименование — это запись под новым именем и удаление старой записи
        if (ok && savedName && savedName !== name) {
            if (!await remove(savedName, draftContext)) toast(`Прежнее отображение «${savedName}» осталось в списке`, 'Удалите его вручную', 'err');
        }
        setSaving(false);
        if (!ok) return false;
        setLayout(next);
        setSnapshot(JSON.stringify(next));
        setSavedName(name);
        setEditingName(false);
        localStorage.setItem(lastLayoutKey(profileId), name);
        toast(`Отображение «${name}» сохранено`, '', 'ok');
        return true;
    };

    const handleSave = () => {
        if (nameError) {
            toast(nameError, 'Исправьте название отображения', 'err');
            startEditName();
            return;
        }
        void persist(layout.name);
    };

    // Новое отображение сразу попадает в список: пустая сетка под свободным именем, имя тут же правится
    const createLayout = async () => {
        if (creating || saving || blocked) return;
        const fresh = emptyLayout(freeName('Новое отображение'));
        const stored = layoutToSaved(fresh, Date.now());
        setCreating(true);
        const ok = await save(stored, context);
        setCreating(false);
        if (!ok) return;
        setFreshName(stored.name);
        applyLayout(stored);
        nameBackup.current = stored.name;
        setEditingName(true);
    };

    const handleDelete = async (name: string) => {
        setConfirmDelete(null);
        setLeavingName(name);
        // Строка уходит видимо: запрос и анимация идут вместе, список меняется после обоих
        const [ok] = await Promise.all([remove(name, draftContext), new Promise(resolve => window.setTimeout(resolve, 180))]);
        setLeavingName(null);
        if (!ok) return;
        if (localStorage.getItem(lastLayoutKey(profileId)) === name) localStorage.removeItem(lastLayoutKey(profileId));
        // Открытое отображение удалено — открывается соседнее; чужое открытое не трогаем
        if (name === savedName) applyLayout(layouts.find(item => item.name !== name) ?? null);
    };

    // ─── Название отображения ───────────────────────────────────

    const startEditName = () => {
        nameBackup.current = layout.name;
        setEditingName(true);
    };

    // Esc и пустое имя возвращают прежнее; Enter и уход из поля оставляют набранное
    const finishEditName = (revert: boolean) => {
        setEditingName(false);
        if (revert || (!layout.name.trim() && nameBackup.current.trim())) {
            setLayout(prev => ({ ...prev, name: nameBackup.current }));
        }
    };

    useEffect(() => {
        if (!editingName) return;
        nameInput.current?.focus();
        nameInput.current?.select();
    }, [editingName]);

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
                <span className="nm" data-tip={source.fault ? `${source.fault.label}: ${source.fault.text}` : undefined}>{source.name}</span>
                <span
                    className="num"
                    style={place === 'вне сетки' ? { color: 'var(--warn)' } : undefined}
                    data-tip={unusable ? 'Ни один поток камеры не назначен на просмотр' : undefined}
                >
                    {unusable ? 'нет потока' : place ?? '—'}
                </span>
            </button>
        );
    };

    const flashAir = useFlash<HTMLSpanElement>(`${counts.live}/${counts.total}`, counts.live < counts.total ? 'warn' : '');

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

                <div className="live-pop" ref={overlaysRef}>
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
                            <Switch on={layout.overlays.stats} onToggle={value => setOverlay('stats', value)}>Кадры и битрейт</Switch>
                            <Switch on={layout.overlays.sources} onToggle={value => setOverlay('sources', value)}>Легенда источников рамок</Switch>
                        </div>
                    )}
                </div>

                <div className="zoom">
                    <span ref={flashAir} className={`pill${counts.total === 0 ? ''
                        : counts.live < counts.total ? ' warn' : ' ok'}`}>
                        <span className="dot" />
                        {counts.live} из {counts.total} в эфире
                    </span>
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
                    sources={draftContext === context && !blocked ? sources : []}
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
                    onSurroundViewModeChange={setSurroundViewMode}
                    onLiveCount={handleLiveCount}
                    onCellStats={setCellStats}
                    cellControls="correction"
                    correctionLinks={correctionLinks}
                    correctionRequest={correctionRequest}
                    onCorrectionBusy={handleCorrectionBusy}
                />

                <aside className="settings">
                    <div className="sect">
                        <span className="eyebrow live-head">
                            Сохранённые сетки
                            <span className="live-acts">
                                {dirty && (
                                    <button className="btn btn--acc btn--sm live-save" disabled={saving} onClick={handleSave}>
                                        Сохранить
                                    </button>
                                )}
                                <button
                                    className="icon-btn live-add"
                                    data-tip="Новое отображение"
                                    aria-label="Новое отображение"
                                    disabled={creating || saving || blocked}
                                    onClick={() => guard(() => void createLayout())}
                                >
                                    <Icon name="plus" size={14} />
                                </button>
                            </span>
                        </span>

                        <div className="live-list">
                            {layouts.map(item => {
                                const selected = item.name === savedName;
                                const editing = selected && editingName;
                                return (
                                    <div
                                        key={item.name}
                                        className={`live-item${selected ? ' is-sel' : ''}${freshName === item.name ? ' is-new' : ''}${leavingName === item.name ? ' is-leaving' : ''}`}
                                        onAnimationEnd={() => { if (freshName === item.name) setFreshName(null); }}
                                    >
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            className="row-item"
                                            onClick={() => { if (!selected) guard(() => applyLayout(item)); }}
                                            onKeyDown={event => {
                                                if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                                                    event.preventDefault();
                                                    if (!selected) guard(() => applyLayout(item));
                                                }
                                            }}
                                        >
                                            <span className="chip-col" style={{ background: 'var(--acc)' }} />
                                            {editing ? (
                                                <input
                                                    ref={nameInput}
                                                    className={`live-name-inp${nameError ? ' is-err' : ''}`}
                                                    value={layout.name}
                                                    maxLength={60}
                                                    aria-label="Название отображения"
                                                    aria-invalid={Boolean(nameError)}
                                                    onChange={event => setLayout(prev => ({ ...prev, name: event.target.value }))}
                                                    onBlur={() => finishEditName(false)}
                                                    onKeyDown={event => {
                                                        if (event.key === 'Enter') { event.preventDefault(); finishEditName(false); }
                                                        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEditName(true); }
                                                    }}
                                                />
                                            ) : (
                                                <span
                                                    className={`nm${selected ? ' is-edit' : ''}`}
                                                    data-tip={selected ? 'Нажмите, чтобы переименовать' : undefined}
                                                    onClick={selected ? event => { event.stopPropagation(); startEditName(); } : undefined}
                                                >
                                                    {selected ? layout.name || item.name : item.name}
                                                </span>
                                            )}
                                            <span className="num">{gridLabel(selected ? layout.grid : layoutFromSaved(item).grid)}</span>
                                        </div>
                                        <button
                                            className="live-del"
                                            data-tip="Удалить отображение"
                                            aria-label={`Удалить отображение «${item.name}»`}
                                            disabled={Boolean(leavingName)}
                                            onClick={() => setConfirmDelete(item.name)}
                                        >
                                            <Icon name="trash" size={18} />
                                        </button>
                                    </div>
                                );
                            })}
                            {layouts.length === 0 && <p className="hint">Сохранённых отображений нет. Добавьте первое кнопкой «+».</p>}
                            {editingName && nameError && <p className="hint is-err live-name-err">{nameError}</p>}
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
                                <div className="field">
                                    <label>Поток</label>
                                    <Select
                                        value={resolved.key ?? ''}
                                        options={cellSource.viewStreams.map(stream => ({
                                            value: stream.key,
                                            label: stream.label,
                                        }))}
                                        onChange={value => setCellStream(cellSource.id, value)}
                                        placeholder="нет потоков"
                                    />
                                </div>

                                <div className="field">
                                    <label>Задержка</label>
                                    <span className="live-val num">{num(cellStats?.rttMs, 0)}</span>
                                    <span className="unit">мс</span>
                                </div>
                                <div className="field">
                                    <label>Потерь пакетов</label>
                                    <span className="live-val num">{num(cellStats?.lossPct, 2)}</span>
                                    <span className="unit">%</span>
                                </div>

                                <div className="live-switches">
                                    {cellSource.hasNeural && (
                                        <Switch on={Boolean(layout.detections[cellSource.id])} onToggle={value => setDetections(cellSource.id, value)}>Рамки обнаружений</Switch>
                                    )}
                                    {cellSource.hasBirdview && correctionLinks[cellSource.id] && (
                                        <Switch
                                            on={Boolean(layout.corrections[cellSource.id])}
                                            disabled={Boolean(correctionBusy[cellSource.id])}
                                            onToggle={value => requestCorrection(cellSource.id, value)}
                                        >
                                            Коррекция дисторсии
                                        </Switch>
                                    )}
                                </div>
                            </>
                        )}
                    </div>

                    <div className="sect">
                        <span className="eyebrow">
                            <span className="seps"><span>Источники</span><span>камеры</span></span>
                        </span>
                        {cameraSources.map(renderSourceRow)}
                    </div>

                    {virtualSources.length > 0 && (
                        <div className="sect">
                            <span className="eyebrow">
                                <span className="seps"><span>Источники</span><span>собранные потоки</span></span>
                            </span>
                            {virtualSources.map(renderSourceRow)}
                        </div>
                    )}
                </aside>
            </div>


            {freeGridOpen && (
                <FreeGridModal
                    grid={layout.grid}
                    onClose={() => setFreeGridOpen(false)}
                    onApply={grid => { applyGrid(grid); setFreeGridOpen(false); }}
                />
            )}

            {confirmDelete !== null && (
                <Modal
                    title="Удалить отображение"
                    onClose={() => setConfirmDelete(null)}
                    footer={
                        <>
                            <button className="btn" onClick={() => setConfirmDelete(null)}>Отмена</button>
                            <button className="btn btn--err" onClick={() => void handleDelete(confirmDelete)}>Удалить</button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <p>Отображение «{confirmDelete}» будет удалено без возможности вернуть.</p>
                    </div>
                </Modal>
            )}

            {pending && (
                <Modal
                    title="Несохранённые правки"
                    onClose={() => { if (!saving) { setPending(null); cancelNavigation(); } }}
                    footer={
                        <>
                            <button className="btn" disabled={saving} onClick={() => { setPending(null); cancelNavigation(); }}>Отмена</button>
                            <button
                                className="btn"
                                disabled={saving}
                                onClick={() => { const action = pending; setPending(null); action(); }}
                            >
                                Не сохранять
                            </button>
                            <button
                                className="btn btn--acc"
                                disabled={saving || draftContext !== context || Boolean(nameError)}
                                data-tip={nameError || undefined}
                                onClick={async () => {
                                    const action = pending;
                                    // Безымянному отображению имя подбирается само
                                    if (await persist(layout.name)) { setPending(null); action(); }
                                }}
                            >
                                Сохранить
                            </button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <p>{draftContext !== context ? 'Профиль уже изменился. Черновик относится к прежнему профилю и не будет перенесён в новый.' : 'В отображении есть несохранённые правки.'}</p>
                    </div>
                </Modal>
            )}
        </section>
    );
}
