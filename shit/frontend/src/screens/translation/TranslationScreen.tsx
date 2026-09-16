/**
 * Трансляция — прямой эфир на изделии.
 *
 * Отдельный экран без оболочки и без авторизации: на панель он поднимается
 * автозапуском браузера. Стена та же, что в редакторе, обвязка другая —
 * постоянная планка сверху (автоскрытия больше нет) и шторка со списком
 * отображений и источников.
 *
 * Правки здесь всегда эфемерны: оператор переставляет камеры и переключает
 * слои до перезагрузки страницы, файл отображения не трогается. Сохранение
 * живёт только в редакторе.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, IconSprite } from '../../app/Icons';
import { Select } from '../../app/Select';
import { formatDeviceDate, formatDeviceTime, useDeviceClock } from '../../app/useDeviceClock';
import { useLayouts, type SavedLayout } from '../../hooks/Layouts';
import { api } from '../../services/api';
import { signalingWsUrl } from '../../services/devices';
import { wsUrl } from '../../utils/constants';
import { isProbeCamera } from '../../utils/probeFilter';
import type { CPPCamera, VirtualStream } from '../../types';
import { Wall } from '../live/Wall';
import { cameraToWallSource, virtualToWallSource, type WallSource } from '../live/sources';
import { emptyLayout, layoutFromSaved, PRESETS, type LayoutState } from '../live/model';
import { useCorrectionLinks } from '../live/useCorrectionLinks';
import '../../styles/tokens.css';
import '../../styles/ui.css';
import './translation.css';

const SOURCES_POLL_MS = 10_000;

// Отображений нет — показываем временную сетку, а не ошибку
const FALLBACK_GRID = PRESETS[PRESETS.length - 1].grid;

function layoutNameFromPath(): string {
    const parts = window.location.pathname.split('/').filter(Boolean);
    // /translation/<имя>
    return parts.length > 1 ? decodeURIComponent(parts[1]) : '';
}

export default function TranslationScreen() {
    const { layouts, loading, loadError } = useLayouts();
    const { unixMs, source } = useDeviceClock();
    const correctionLinks = useCorrectionLinks();

    const [cameras, setCameras] = useState<CPPCamera[]>([]);
    const [virtual, setVirtual] = useState<VirtualStream[]>([]);

    const [layout, setLayout] = useState<LayoutState>(() => emptyLayout());
    const [switchKey, setSwitchKey] = useState('init');
    const [fallback, setFallback] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [counts, setCounts] = useState({ live: 0, total: 0 });
    // Тач: выбранный в списке источник ждёт нажатия по ячейке
    const [armed, setArmed] = useState<string | null>(null);

    const switchSeq = useRef(0);
    const initialized = useRef(false);

    // ─── Источники ──────────────────────────────────────────────

    useEffect(() => {
        let alive = true;

        const load = async () => {
            try {
                const { cameras: list, virtual: streams } = await api.getSources();
                if (!alive) return;
                setCameras(list.filter(camera => !isProbeCamera(camera.id)));
                setVirtual(streams);
            } catch {
                // Молчим: планка и так покажет, что в эфире ноль ячеек
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

    const sourceGroups: Array<[string, WallSource[]]> = [
        ['Камеры', sources.filter(item => item.kind === 'camera')],
        ['Собранные потоки', sources.filter(item => item.kind === 'virtual')],
    ];

    const signalingUrlOf = useCallback((sourceId: string) => {
        const owner = sources.find(item => item.id === sourceId)?.deviceId;
        return owner ? signalingWsUrl(owner, `/client/${sourceId}`) : wsUrl(`/signaling/client/${sourceId}`);
    }, [sources]);

    // ─── Выбор отображения ──────────────────────────────────────

    const applyLayout = useCallback((saved: SavedLayout) => {
        switchSeq.current += 1;
        setLayout(layoutFromSaved(saved));
        setFallback(false);
        setArmed(null);
        setSwitchKey(`${saved.name}#${switchSeq.current}`);
        window.history.replaceState(null, '', `/translation/${encodeURIComponent(saved.name)}`);
    }, []);

    // Свернуть шторку и снять выбор источника заодно
    const closeDrawer = useCallback(() => {
        setDrawerOpen(false);
        setArmed(null);
    }, []);

    useEffect(() => {
        if (loading || initialized.current) return;
        initialized.current = true;

        const requested = layoutNameFromPath();
        const found = (requested && layouts.find(item => item.name === requested)) || layouts[0];

        if (found) {
            applyLayout(found);
            return;
        }

        // Отображений нет — временная сетка с раскрытой шторкой
        switchSeq.current += 1;
        setLayout({ ...emptyLayout(), grid: FALLBACK_GRID });
        setFallback(true);
        setDrawerOpen(true);
        setSwitchKey(`fallback#${switchSeq.current}`);
    }, [loading, layouts, applyLayout]);

    // ─── Эфемерные правки ───────────────────────────────────────

    const assign = (cellId: string, sourceId: string) => {
        setLayout(prev => ({ ...prev, cells: { ...prev.cells, [cellId]: sourceId } }));
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

    const setCorrected = useCallback((cameraId: string, value: boolean) => {
        setLayout(prev => ({ ...prev, corrections: { ...prev.corrections, [cameraId]: value } }));
    }, []);

    const setDetections = useCallback((cameraId: string, value: boolean) => {
        setLayout(prev => ({ ...prev, detections: { ...prev.detections, [cameraId]: value } }));
    }, []);

    // Только сессия: после перезагрузки поток снова из сохранённой сетки
    const setStream = useCallback((cameraId: string, streamKey: string) => {
        setLayout(prev => ({ ...prev, streams: { ...prev.streams, [cameraId]: streamKey } }));
    }, []);

    const handleLiveCount = useCallback((live: number, total: number) => {
        setCounts(prev => (prev.live === live && prev.total === total ? prev : { live, total }));
    }, []);

    const cellOfSource = (sourceId: string): string | null => {
        const found = Object.entries(layout.cells).find(([, id]) => id === sourceId);
        if (!found) return null;
        const index = layout.grid.cells.findIndex(cell => cell.id === found[0]);
        return index >= 0 ? `яч. ${index + 1}` : null;
    };

    // Перезапуск всех сессий: стена разберёт их по очереди и поднимет заново
    const reloadStreams = () => {
        switchSeq.current += 1;
        setSwitchKey(`${fallback ? 'fallback' : layout.name}#${switchSeq.current}`);
    };

    const toggleFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => {});
    };

    const exit = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        window.location.href = '/new/live';
    };

    return (
        // Нажатие мимо ячейки и мимо источника снимает выбор источника
        <div className="tr" onClick={() => { if (armed) setArmed(null); }}>
            <IconSprite />

            <div className="tr-bar">
                <button
                    className="icon-btn tr-plain"
                    title="Список отображений"
                    onClick={() => setDrawerOpen(value => !value)}
                >
                    <Icon name="menu" />
                </button>

                <b className="tr-title">Трансляция</b>
                {layouts.length > 0 ? (
                    <div className="tr-select" title="Отображение в эфире">
                        <Select
                            value={fallback ? '' : layout.name}
                            placeholder="временная сетка"
                            options={layouts.map(item => ({ value: item.name, label: item.name }))}
                            onChange={value => {
                                const next = layouts.find(item => item.name === value);
                                if (next) applyLayout(next);
                            }}
                        />
                    </div>
                ) : (
                    <span className="tr-name">{fallback ? 'временная сетка' : layout.name}</span>
                )}

                <span className={`pill${counts.live < counts.total ? ' warn' : ' ok'}`}>
                    <span className="dot" />
                    {counts.live} из {counts.total} в эфире
                </span>

                <span className="spacer" />

                <span
                    className={`pill num${source === 'can' ? '' : ' is-dim'}`}
                    title={source === 'can' ? 'Время изделия' : 'Время сервера, шина молчит'}
                >
                    <span className="seps">
                        <span>{formatDeviceDate(unixMs)}</span>
                        <span>{formatDeviceTime(unixMs)}</span>
                    </span>
                </span>

                <button className="icon-btn tr-plain" title="Обновить все потоки" onClick={reloadStreams}>
                    <Icon name="refresh" />
                </button>
                <button className="icon-btn tr-plain" title="Во весь экран" onClick={toggleFullscreen}>
                    <Icon name="full" />
                </button>
                <button className="icon-btn tr-plain" title="Выйти в редактор" onClick={exit}>
                    <Icon name="x" />
                </button>
            </div>

            {loadError && (
                <div className="banner is-err" style={{ borderRadius: 0, borderLeft: 'none', borderRight: 'none' }}>
                    <Icon name="warn" />
                    {loadError}
                </div>
            )}

            {fallback && (
                <div className="banner" style={{ borderRadius: 0, borderLeft: 'none', borderRight: 'none' }}>
                    <Icon name="warn" />
                    Отображения не настроены — показана временная сетка, изменения не сохраняются.
                    <button className="btn btn--sm" onClick={exit}>Создать отображение</button>
                </div>
            )}

            <div className="tr-body">
                <aside className={`tr-drawer${drawerOpen ? ' is-open' : ''}`} aria-hidden={!drawerOpen}>
                        <div className="eyebrow tr-cap">Отображения</div>
                        {layouts.length === 0 && <p className="hint">Сохранённых отображений нет.</p>}
                        {layouts.map(item => (
                            <button
                                key={item.name}
                                className={`row-item${!fallback && item.name === layout.name ? ' is-sel' : ''}`}
                                onClick={() => applyLayout(item)}
                            >
                                <span className="chip-col" style={{ background: 'var(--acc)' }} />
                                <span className="nm">{item.name}</span>
                            </button>
                        ))}

                        {/* Камеры отдельно от потоков модулей (нейронка, 360) */}
                        {sourceGroups.map(([caption, items]) => items.length > 0 && (
                            <div key={caption} style={{ display: 'contents' }}>
                                <div className="eyebrow tr-cap">{caption}</div>
                                {items.map(item => (
                                    <button
                                        key={item.id}
                                        className={`row-item${item.id === armed ? ' is-armed' : ''}`}
                                        draggable
                                        onDragStart={event => {
                                            event.dataTransfer.setData('text/plain', `source:${item.id}`);
                                            setArmed(item.id);
                                        }}
                                        onDragEnd={() => setArmed(null)}
                                        onClick={event => {
                                            event.stopPropagation();
                                            setArmed(prev => (prev === item.id ? null : item.id));
                                        }}
                                    >
                                        <span
                                            className="chip-col"
                                            style={{ background: item.offline || !item.active ? 'var(--err)' : 'var(--ok)' }}
                                        />
                                        <span className="nm">{item.name}</span>
                                        <span className="num">{cellOfSource(item.id) ?? '—'}</span>
                                    </button>
                                ))}
                            </div>
                        ))}

                        <span className="tr-fill" />
                        <button className="btn btn--sm btn--wide tr-collapse" onClick={closeDrawer}>
                            Свернуть
                        </button>
                </aside>

                <Wall
                    grid={layout.grid}
                    layout={layout}
                    sources={sources}
                    switchKey={switchKey}
                    signalingUrlOf={signalingUrlOf}
                    deviceTimeMs={unixMs}
                    editable
                    pickedSource={armed}
                    onPickPlace={cellId => { if (armed) assign(cellId, armed); setArmed(null); }}
                    onAssign={assign}
                    onSwap={swap}
                    onCorrectedChange={setCorrected}
                    onDetectionsChange={setDetections}
                    onStreamChange={setStream}
                    onLiveCount={handleLiveCount}
                    correctionLinks={correctionLinks}
                />
            </div>
        </div>
    );
}
