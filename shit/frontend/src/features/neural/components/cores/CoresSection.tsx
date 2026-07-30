import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { neuralApi } from '../../api/client';
import type {
    ActiveDesc,
    CameraLayout,
    CameraInfo,
    CameraStreamInfo,
    ConfigSummary,
    SlotStatus,
    StreamingDesc,
    SystemInfo,
} from '../../api/types';
import { StreamCard } from './StreamCard';
import { CameraModal } from './CameraModal';

export interface CamOption { id: string; name: string; resolution?: string }

/** Поток нейросети: конфигурация + камера(ы) + ядра + доставка. */
export interface Stream {
    key: string;
    configId: string;
    cores: number[];
    layout: CameraLayout;
    streaming: StreamingDesc;
    mask: string[];
}

const DEFAULT_SYSTEM: SystemInfo = {
    platform: 'unknown', label: '—', npu_cores: 0, max_streams: -1, mode: 'unlimited',
};

// Человекочитаемые названия событий — идентификаторы приходят с бэкенда.
const EVENT_NAMES: Record<string, string> = {
    created: 'Создан', confirmed: 'Подтверждён', updated: 'Движение',
    lost: 'Потерян', recovered: 'Восстановлен', removed: 'Удалён',
};
const FALLBACK_EVENTS = ['created', 'confirmed', 'updated', 'lost', 'recovered', 'removed'];

// ── раскладка (пока single) ─────────────────────────────────
const singleCam = (l: CameraLayout | undefined): string | null =>
    l?.single || l?.tiles?.[0]?.camera || null;

const layoutOf = (camId: string | null): CameraLayout => ({
    mode: 'single', rows: 1, cols: 1,
    single: camId ?? undefined,
    tiles: camId ? [{ camera: camId, rect: [0, 0, 1, 1] }] : [],
});

const clone = (s: Stream[]): Stream[] => s.map((x) => ({ ...x, cores: [...x.cores], mask: [...x.mask], streaming: { ...x.streaming }, layout: JSON.parse(JSON.stringify(x.layout)) }));

/** Разрешение основного потока камеры. */
function mainResolution(streams?: Record<string, CameraStreamInfo>): string | undefined {
    if (!streams) return undefined;
    let best: CameraStreamInfo | null = null;
    for (const s of Object.values(streams)) {
        if (!s.width || !s.height) continue;
        if (!best || s.width * s.height > best.width! * best.height!) best = s;
    }
    return best ? `${best.width}×${best.height}` : undefined;
}

export function CoresSection() {
    const [system, setSystem] = useState<SystemInfo>(DEFAULT_SYSTEM);
    const [streams, setStreams] = useState<Stream[]>([]);
    const [saved, setSaved] = useState<Stream[]>([]);
    const [configs, setConfigs] = useState<ConfigSummary[]>([]);
    const [trackerBy, setTrackerBy] = useState<Record<string, boolean>>({});
    const [cameras, setCameras] = useState<CamOption[]>([]);
    const [eventTypes, setEventTypes] = useState<string[]>(FALLBACK_EVENTS);
    const [status, setStatus] = useState<SlotStatus[]>([]);
    const [camModalFor, setCamModalFor] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const nextKey = useRef(1);
    const uid = () => `s${nextKey.current++}`;

    const hasTracker = useCallback((cid: string) => !!trackerBy[cid], [trackerBy]);

    // ── загрузка ───────────────────────────────────────────────
    const descToStream = useCallback((d: ActiveDesc): Stream => {
        const cam = singleCam(d.camera_layout) ?? d.camera_matrix?.[0]?.[0] ?? null;
        return {
            key: uid(),
            configId: d.config_id,
            cores: d.cores ?? [],
            layout: layoutOf(cam),
            streaming: d.streaming ?? { enabled: false, name: '' },
            mask: d.event_mask ?? [],
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const reloadState = useCallback(async () => {
        const descs = await neuralApi.getState().catch(() => [] as ActiveDesc[]);
        const s = descs.map(descToStream);
        setStreams(clone(s));
        setSaved(clone(s));
    }, [descToStream]);

    const reloadConfigs = useCallback(async () => {
        const { configurations } = await neuralApi.listConfigurations();
        setConfigs(configurations);
        // подтягиваем полные конфиги, чтобы знать, у кого есть трекер (фильтр)
        const entries = await Promise.all(
            configurations.map(async (c) => {
                try {
                    const full = await neuralApi.getConfiguration(c.id);
                    return [c.id, !!full.tracker] as const;
                } catch {
                    return [c.id, false] as const;
                }
            }),
        );
        setTrackerBy(Object.fromEntries(entries));
    }, []);

    const reloadCameras = useCallback(async () => {
        try {
            const res = await neuralApi.listCameras();
            if (res.cameras) {
                const cams = Object.entries(res.cameras)
                    .filter(([, v]: [string, CameraInfo]) => (v.type ?? v.camera_type) === 2)
                    .map(([id, v]) => ({ id, name: v.display_name ?? id, resolution: mainResolution(v.streams) }));
                setCameras(cams);
            }
        } catch { /* сервер недоступен */ }
    }, []);

    const loadStatus = useCallback(() => {
        neuralApi.getStatus().then(setStatus).catch(() => setStatus([]));
    }, []);

    useEffect(() => {
        neuralApi.getSystem().then(setSystem).catch(() => setSystem(DEFAULT_SYSTEM));
        neuralApi.getEventTypes().then((r) => r.events?.length && setEventTypes(r.events.map((e) => e.type))).catch(() => {});
        reloadConfigs().catch(() => {});
        reloadState().catch(() => {});
        reloadCameras();
        loadStatus();
        const t = setInterval(loadStatus, 3000);
        return () => clearInterval(t);
    }, [reloadConfigs, reloadState, reloadCameras, loadStatus]);

    // ── производные ────────────────────────────────────────────
    const occupiedCoresAll = useMemo(() => {
        const s = new Set<number>();
        for (const st of streams) for (const c of st.cores) s.add(c);
        return s;
    }, [streams]);

    const usedCameras = useMemo(() => {
        const m: Record<string, string> = {};
        for (const st of streams) { const c = singleCam(st.layout); if (c) m[st.key] = c; }
        return m;
    }, [streams]);

    const dirty = useMemo(() => JSON.stringify(streams) !== JSON.stringify(saved), [streams, saved]);

    const runningKeys = useMemo(() => {
        const set = new Set<string>();
        for (const s of status) {
            if (!s.running) continue;
            const cam = singleCam(s.camera_layout) ?? s.camera_matrix?.[0]?.[0] ?? '';
            set.add(s.config_id + '|' + cam);
        }
        return set;
    }, [status]);
    const supervisorRunning = status.some((s) => s.running);

    const canCreate = useMemo(() => {
        if (system.mode === 'single') return streams.length < 1;
        if (system.mode === 'cores') return occupiedCoresAll.size < system.npu_cores;
        return true;
    }, [system, streams.length, occupiedCoresAll]);

    // ── мутации потоков ────────────────────────────────────────
    const patchStream = useCallback((key: string, patch: Partial<Stream>) => {
        setStreams((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    }, []);

    const freeCore = useCallback(() => {
        for (let c = 0; c < system.npu_cores; c++) if (!occupiedCoresAll.has(c)) return c;
        return null;
    }, [system.npu_cores, occupiedCoresAll]);

    const createStream = useCallback((configId?: string) => {
        if (!canCreate || configs.length === 0) return;
        const cid = configId ?? configs[0].id;
        const cores = system.mode === 'cores' ? [freeCore()].filter((c): c is number => c != null)
            : system.mode === 'single' ? [0] : [];
        setStreams((list) => [
            ...list,
            { key: uid(), configId: cid, cores, layout: layoutOf(null), streaming: { enabled: false, name: '' }, mask: [] },
        ]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canCreate, configs, system.mode, freeCore]);

    const removeStream = useCallback((key: string) => {
        setStreams((list) => list.filter((s) => s.key !== key));
        setCamModalFor((k) => (k === key ? null : k));
    }, []);

    const toggleCore = useCallback((key: string, core: number) => {
        setStreams((list) => {
            const occByOthers = new Set<number>();
            for (const s of list) if (s.key !== key) for (const c of s.cores) occByOthers.add(c);
            return list.map((s) => {
                if (s.key !== key) return s;
                if (s.cores.includes(core)) return s.cores.length > 1 ? { ...s, cores: s.cores.filter((c) => c !== core) } : s;
                if (occByOthers.has(core)) return s;
                return { ...s, cores: [...s.cores, core].sort((a, b) => a - b) };
            });
        });
    }, []);

    const pickCamera = useCallback((key: string, camId: string | null) => {
        patchStream(key, { layout: layoutOf(camId) });
    }, [patchStream]);

    // ── сохранение / супервизор ────────────────────────────────
    function streamToDesc(s: Stream): ActiveDesc {
        const cam = singleCam(s.layout);
        return {
            config_id: s.configId,
            camera_layout: layoutOf(cam),
            cores: s.cores,
            streaming: { enabled: s.streaming.enabled, name: s.streaming.name },
            event_mask: hasTracker(s.configId) ? s.mask : [],
        };
    }

    function validate(): string | null {
        for (const s of streams) {
            if (!singleCam(s.layout)) {
                const name = configs.find((c) => c.id === s.configId)?.name ?? s.configId;
                return `Поток «${name}»: не выбрана камера`;
            }
        }
        return null;
    }

    async function apply() {
        const problem = validate();
        if (problem) { setErr(problem); return; }
        setBusy(true); setErr(null);
        try {
            await neuralApi.setState(streams.map(streamToDesc));
            setSaved(clone(streams));
            loadStatus();
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    function reset() {
        setStreams(clone(saved));
        setErr(null);
    }

    async function control(action: 'start' | 'restart' | 'stop') {
        setBusy(true); setErr(null);
        try {
            await neuralApi[action]();
            loadStatus();
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    // ── рендер шапки занятости ─────────────────────────────────
    function renderAlloc() {
        if (system.mode === 'cores') {
            return Array.from({ length: system.npu_cores }, (_, c) => {
                const owner = streams.find((s) => s.cores.includes(c));
                const name = owner ? (configs.find((cf) => cf.id === owner.configId)?.name ?? owner.configId) : 'свободно';
                return (
                    <div key={c} className={`core-pill${owner ? ' alloc-busy' : ''}`}>
                        <span className="cn">C{c}</span>
                        <span className="cs">{name}</span>
                    </div>
                );
            });
        }
        if (system.mode === 'single') {
            const busyS = streams.length > 0;
            return (
                <span className={`slot-ind ${busyS ? 'busy' : 'free'}`}>
                    <span className="d" />{busyS ? 'СЛОТ ЗАНЯТ' : 'СЛОТ СВОБОДЕН'}
                </span>
            );
        }
        return (
            <span className="pl-badge"><span className="gpu">◆</span> {system.label} · {streams.length} поток(ов)</span>
        );
    }

    const subOf = system.mode === 'cores' ? `${occupiedCoresAll.size} из ${system.npu_cores} ядер занято`
        : system.mode === 'single' ? 'одно ядро NPU · не более 1 потока' : 'без ограничений';

    const modalStream = streams.find((s) => s.key === camModalFor) ?? null;

    return (
        <div className="cores-section">
            {/* Шапка платформы */}
            <div className="pl-bar">
                <div className="pl-titles">
                    <span className="pl-title">{system.label}</span>
                    <span className="pl-sub">{subOf}</span>
                </div>
                <div className="pl-body">{renderAlloc()}</div>
            </div>

            {/* Каталог + доска */}
            <div className="strm-layout">
                <div className="strm-catalog">
                    <span className="section-label" style={{ margin: 0 }}>Конфигурации</span>
                    {configs.length === 0 && <span className="hint">нет конфигураций</span>}
                    {configs.map((c) => {
                        const used = streams.filter((s) => s.configId === c.id).length;
                        return (
                            <div
                                key={c.id}
                                className={`cat-item${canCreate ? ' click' : ''}`}
                                onClick={() => canCreate && createStream(c.id)}
                                title={canCreate ? 'Создать поток с этой конфигурацией' : undefined}
                            >
                                <div className="n">{c.name || c.id}</div>
                                <div className="m">
                                    <span className="id">{c.id}</span>
                                    {used > 0 && <span className="strm-badge filt" style={{ padding: '2px 8px' }}>×{used}</span>}
                                </div>
                            </div>
                        );
                    })}
                    <button className="btn btn-accent" style={{ marginTop: 4 }} disabled={!canCreate} onClick={() => createStream()}>
                        + поток
                    </button>
                    {!canCreate && (
                        <span className="hint" style={{ textAlign: 'center' }}>
                            {system.mode === 'single' ? 'лимит: 1 поток' : 'все ядра заняты'}
                        </span>
                    )}
                </div>

                <div className="strm-board">
                    {streams.length === 0 ? (
                        <div className="strm-empty">Потоков нет — выберите конфигурацию слева или нажмите «+ поток»</div>
                    ) : (
                        <div className="strm-board-grid">
                            {streams.map((s) => {
                                const cam = singleCam(s.layout);
                                const camName = cam ? (cameras.find((c) => c.id === cam)?.name ?? cam) : null;
                                const occOthers = new Set<number>();
                                for (const o of streams) if (o.key !== s.key) for (const c of o.cores) occOthers.add(c);
                                const running = runningKeys.has(s.configId + '|' + (cam ?? ''));
                                return (
                                    <StreamCard
                                        key={s.key}
                                        stream={s}
                                        configOptions={configs.map((c) => ({ id: c.id, name: c.name || c.id }))}
                                        hasTracker={hasTracker(s.configId)}
                                        editable
                                        running={running}
                                        platform={system}
                                        occupiedCores={occOthers}
                                        cameraName={camName}
                                        eventTypes={eventTypes}
                                        eventNames={EVENT_NAMES}
                                        onPatch={(p) => patchStream(s.key, p)}
                                        onToggleCore={(c) => toggleCore(s.key, c)}
                                        onRemove={() => removeStream(s.key)}
                                        onOpenCamera={() => setCamModalFor(s.key)}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {err && <div className="error-box" style={{ margin: '14px 0' }}>{err}</div>}

            {/* Подвал */}
            <div className="strm-footer">
                <span className={`sup-badge ${supervisorRunning ? 'on' : 'off'}`}>
                    <span className="d" />{supervisorRunning ? 'В РАБОТЕ' : 'ОСТАНОВЛЕНО'}
                </span>
                {dirty && <span className="pending-badge">изменения не применены</span>}

                <div className="strm-footer-actions">
                    <button className="btn btn-ghost" disabled={busy || !dirty} onClick={reset}>Сбросить</button>
                    <button className="btn btn-primary" disabled={busy || !dirty} onClick={apply}>Применить</button>
                    {!supervisorRunning ? (
                        <button className="btn btn-accent" disabled={busy} onClick={() => control('start')}>Запустить</button>
                    ) : (
                        <>
                            <button className="btn btn-ghost" disabled={busy} onClick={() => control('restart')}>Перезапуск</button>
                            <button className="btn btn-danger" disabled={busy} onClick={() => control('stop')}>Остановить</button>
                        </>
                    )}
                </div>
            </div>

            {/* Модалка выбора камеры */}
            {modalStream && (
                <CameraModal
                    configName={configs.find((c) => c.id === modalStream.configId)?.name ?? modalStream.configId}
                    cams={cameras}
                    current={singleCam(modalStream.layout)}
                    excluded={new Set(
                        Object.entries(usedCameras).filter(([k]) => k !== modalStream.key).map(([, v]) => v),
                    )}
                    onPick={(camId) => pickCamera(modalStream.key, camId)}
                    onClose={() => setCamModalFor(null)}
                />
            )}
        </div>
    );
}
