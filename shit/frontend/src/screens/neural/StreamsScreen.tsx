import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Switch } from '../../app/Modal';
import { Select } from '../../app/Select';
import { describeError } from '../../components/webrtc/error-codes';
import { useToast } from '../../features/birdview/components/common/Toast';
import { neuralApi } from '../../features/neural/api/client';
import type { ActiveDesc, CameraLayout, ConfigSummary, SlotStatus, StreamingDesc, SystemInfo } from '../../features/neural/api/types';

interface CamOption {
    id: string;
    name: string;
    resolution?: string;
}

/** Поток на доске: конфигурация × камера, глубина и потолок к/с, стриминг, маска событий */
interface Stream {
    key: string;
    configId: string;
    camera: string | null;
    depth: number;
    fps: number;
    streaming: StreamingDesc;
    mask: string[];
}

const DEFAULT_SYSTEM: SystemInfo = { platform: 'unknown', label: '—', npu_cores: 0 };

// Названия событий трека — идентификаторы приходят с бэкенда
const EVENT_NAMES: Record<string, string> = {
    created: 'Создан', confirmed: 'Подтверждён', updated: 'Движение',
    lost: 'Потерян', recovered: 'Восстановлен', removed: 'Удалён',
};
const FALLBACK_EVENTS = ['created', 'confirmed', 'updated', 'lost', 'recovered', 'removed'];

const singleCam = (l: CameraLayout | undefined): string | null => l?.single || l?.tiles?.[0]?.camera || null;

const layoutOf = (camId: string): CameraLayout => ({
    mode: 'single', rows: 1, cols: 1, single: camId, tiles: [{ camera: camId, rect: [0, 0, 1, 1] }],
});

const clone = (s: Stream[]): Stream[] => s.map(x => ({ ...x, mask: [...x.mask], streaming: { ...x.streaming } }));

const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

const fmtMb = (bytes: number) => `${(bytes / (1 << 20)).toFixed(1)} МБ`;

// Бэкенд отдаёт раскладку описательной фразой (output_layout_name), в строке модели нужно короткое имя
const layoutName = (layout: string): string => {
    const l = layout.toLowerCase();
    if (l.startsWith('single')) return 'SINGLE';
    if (l.startsWith('split')) return 'SPLIT_LEVELS';
    if (l.includes('segmentation')) return 'SEGMENTATION';
    return layout.toUpperCase();
};
const fmt1 = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

interface StreamsScreenProps {
    status: SlotStatus[] | null;
    onRefreshStatus: () => void;
}

export function StreamsScreen({ status, onRefreshStatus }: StreamsScreenProps) {
    const toast = useToast();

    const [system, setSystem] = useState<SystemInfo>(DEFAULT_SYSTEM);
    const [configs, setConfigs] = useState<ConfigSummary[]>([]);
    const [trackerBy, setTrackerBy] = useState<Record<string, boolean>>({});
    const [classCount, setClassCount] = useState<Record<string, number>>({});
    const [cameras, setCameras] = useState<CamOption[]>([]);
    const [eventTypes, setEventTypes] = useState<string[]>(FALLBACK_EVENTS);
    const [streams, setStreams] = useState<Stream[]>([]);
    const [saved, setSaved] = useState<Stream[]>([]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const nextKey = useRef(1);
    const uid = () => `s${nextKey.current++}`;

    const reloadState = useCallback(async () => {
        const descs = await neuralApi.getState().catch(() => [] as ActiveDesc[]);
        const list: Stream[] = descs.map(d => ({
            key: uid(),
            configId: d.config_id,
            camera: singleCam(d.camera_layout),
            depth: Math.max(1, d.depth ?? 1),
            fps: Math.max(1, d.fps ?? 10),
            streaming: d.streaming ?? { enabled: false, name: '' },
            mask: d.event_mask ?? [],
        }));
        setStreams(clone(list));
        setSaved(clone(list));
    }, []);

    const reloadConfigs = useCallback(async () => {
        const { configurations } = await neuralApi.listConfigurations();
        setConfigs(configurations);
        const entries = await Promise.all(configurations.map(async c => {
            try {
                const full = await neuralApi.getConfiguration(c.id);
                return [c.id, !!full.tracker, Object.keys(full.classes ?? {}).length] as const;
            } catch {
                return [c.id, false, 0] as const;
            }
        }));
        setTrackerBy(Object.fromEntries(entries.map(([id, t]) => [id, t])));
        setClassCount(Object.fromEntries(entries.map(([id, , n]) => [id, n])));
    }, []);

    // Камеры с потоком назначения neural; разрешение — из этого потока
    const reloadCameras = useCallback(async () => {
        try {
            const res = await neuralApi.listCameras();
            if (!res.cameras) return;
            const list: CamOption[] = [];
            for (const [id, cam] of Object.entries(res.cameras)) {
                const s = Object.values(cam.streams ?? {}).find(st => st.purposes?.includes('neural'));
                if (!s) continue;
                list.push({ id, name: cam.display_name ?? id, resolution: s.width && s.height ? `${s.width}×${s.height}` : undefined });
            }
            setCameras(list);
        } catch { /* список останется пустым */ }
    }, []);

    useEffect(() => {
        neuralApi.getSystem().then(setSystem).catch(() => setSystem(DEFAULT_SYSTEM));
        neuralApi.getEventTypes().then(r => r.events?.length && setEventTypes(r.events.map(e => e.type))).catch(() => {});
        reloadConfigs().catch(e => setErr(e instanceof Error ? e.message : String(e)));
        reloadState();
        reloadCameras();
    }, [reloadConfigs, reloadState, reloadCameras]);

    const dirty = useMemo(() => JSON.stringify(streams) !== JSON.stringify(saved), [streams, saved]);
    const anyRunning = status?.some(s => s.running) ?? false;

    const statusOf = (s: Stream): SlotStatus | null =>
        status?.find(st => st.config_id === s.configId && singleCam(st.camera_layout) === s.camera) ?? null;

    const configName = (id: string) => configs.find(c => c.id === id)?.name || id;

    // Дубль «та же конфигурация + та же камера» бэкенд отвергает целиком
    const duplicateKeys = useMemo(() => {
        const seen = new Map<string, string>();
        const dups = new Set<string>();
        for (const s of streams) {
            if (!s.camera) continue;
            const k = `${s.configId}|${s.camera}`;
            const first = seen.get(k);
            if (first) { dups.add(first); dups.add(s.key); } else seen.set(k, s.key);
        }
        return dups;
    }, [streams]);

    const problem = useMemo(() => {
        for (const s of streams) if (!s.camera) return `Поток «${configName(s.configId)}»: камера не выбрана`;
        if (duplicateKeys.size) return 'Одна конфигурация дважды на одной камере';
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streams, duplicateKeys, configs]);

    const patchStream = (key: string, p: Partial<Stream>) =>
        setStreams(list => list.map(s => (s.key === key ? { ...s, ...p } : s)));

    const addStream = (configId?: string) => {
        const cid = configId ?? configs[0]?.id;
        if (!cid) return;
        setStreams(list => [...list, { key: uid(), configId: cid, camera: null, depth: 1, fps: 10, streaming: { enabled: false, name: '' }, mask: [] }]);
    };

    const removeStream = (key: string) => setStreams(list => list.filter(s => s.key !== key));

    const toDesc = (s: Stream): ActiveDesc => ({
        config_id: s.configId,
        camera_layout: layoutOf(s.camera ?? ''),
        depth: s.depth,
        fps: s.fps,
        streaming: { enabled: s.streaming.enabled, name: s.streaming.name },
        event_mask: trackerBy[s.configId] ? s.mask : [],
    });

    const apply = async () => {
        if (problem) { setErr(problem); return; }
        setBusy(true);
        setErr(null);
        try {
            await neuralApi.setState(streams.map(toDesc));
            setSaved(clone(streams));
            toast('Потоки применены', `${streams.length} ${plural(streams.length, 'поток', 'потока', 'потоков')}`, 'ok');
            onRefreshStatus();
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const control = async (action: 'start' | 'restart' | 'stop') => {
        setBusy(true);
        setErr(null);
        try {
            await neuralApi[action]();
            onRefreshStatus();
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const cameraOptions = cameras.map(c => ({ value: c.id, label: c.name, hint: c.resolution ? `${c.id} · ${c.resolution}` : c.id }));
    const configOptions = configs.map(c => ({ value: c.id, label: c.name || c.id, hint: c.id }));

    return (
        <>
            <div className="filters">
                <span className="fld"><span className="k">Платформа</span><span className="v">{system.label}</span></span>
                <span className="fld"><span className="k">Ядер NPU</span><span className="v">{system.npu_cores}</span></span>
                <span className="fld"><span className="k">Потоков</span><span className="v">{streams.length}</span></span>
                {dirty && <span className="tag is-warn">изменения не применены</span>}
                {err && <span className="tag is-err">{err}</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                    {status === null
                        ? <span className="pill err"><span className="dot" />нет ответа</span>
                        : anyRunning
                            ? <span className="pill ok"><span className="dot" />обработка идёт</span>
                            : <span className="pill"><span className="dot" />остановлено</span>}
                    <button className="btn" disabled={busy || !dirty} onClick={() => { setStreams(clone(saved)); setErr(null); }}>Сбросить</button>
                    <button className="btn btn--acc" disabled={busy || !dirty} onClick={apply}>Применить</button>
                    <span className="tbar-sep" />
                    {anyRunning ? (
                        <>
                            <button className="btn" disabled={busy} data-tip="Перезапустить все потоки" onClick={() => control('restart')}><Icon name="refresh" className="ico" /></button>
                            <button className="btn btn--err" disabled={busy} onClick={() => control('stop')}>Остановить</button>
                        </>
                    ) : (
                        <button className="btn btn--ok" disabled={busy || saved.length === 0} onClick={() => control('start')}>Запустить</button>
                    )}
                </div>
            </div>

            <div className="nv">
                <div className="nv-main">
                    <div className="nv-body">
                        <div className="nv-grid">
                            {streams.map(s => {
                                const st = statusOf(s);
                                const hasTracker = !!trackerBy[s.configId];
                                const running = !!st?.running;
                                const failed = !!st && !st.running && st.code !== 0;
                                const dup = duplicateKeys.has(s.key);
                                const error = failed ? describeError({ code: st!.code, description: st!.error }) : null;
                                return (
                                    <div key={s.key} className={`card sl-card${running ? ' is-run' : failed ? ' is-err' : ''}`}>
                                        <div className="card-h">
                                            <h3>{configName(s.configId)}</h3>
                                            {!st
                                                ? <span className="tag is-warn">не применён</span>
                                                : running
                                                    ? <span className="tag is-ok">работает</span>
                                                    : <span className={`tag${failed ? ' is-err' : ''}`}>остановлен</span>}
                                            <button className="icon-btn spacer" data-tip="Убрать поток" onClick={() => removeStream(s.key)}><Icon name="trash" size={13} /></button>
                                        </div>
                                        <div className="card-b">
                                            <div className="tf">
                                                <span className="tf-cap">Конфигурация</span>
                                                <Select value={s.configId} options={configOptions} onChange={v => patchStream(s.key, { configId: v, mask: trackerBy[v] ? s.mask : [] })} />
                                            </div>
                                            <div className="tf">
                                                <span className="tf-cap">Камера{dup && <span className="spacer" style={{ color: 'var(--err)' }}>дубль</span>}</span>
                                                <Select
                                                    value={s.camera ?? ''}
                                                    options={cameraOptions}
                                                    onChange={v => patchStream(s.key, { camera: v })}
                                                    placeholder="Не выбрана"
                                                    emptyText="Камер с назначением neural нет"
                                                />
                                            </div>
                                            <div className="tf-row">
                                                <IntField label="Глубина" value={s.depth} min={1} onCommit={v => patchStream(s.key, { depth: v })} />
                                                <IntField label="Кадров/с" value={s.fps} min={1} onCommit={v => patchStream(s.key, { fps: v })} />
                                            </div>
                                            <Switch on={s.streaming.enabled} onToggle={on => patchStream(s.key, { streaming: { ...s.streaming, enabled: on } })}>
                                                Отдавать поток с рамками
                                            </Switch>
                                            {s.streaming.enabled && (
                                                <div className="tf">
                                                    <span className="tf-cap">Имя потока</span>
                                                    <input className="tf-in" value={s.streaming.name} placeholder={`neural_${s.camera ?? ''}`}
                                                        onChange={e => patchStream(s.key, { streaming: { ...s.streaming, name: e.target.value } })} />
                                                </div>
                                            )}
                                            {hasTracker && (
                                                <div className="tf">
                                                    <span className="tf-cap">События в журнал и шлюз</span>
                                                    <div className="evs">
                                                        {eventTypes.map(t => {
                                                            const on = s.mask.includes(t);
                                                            return (
                                                                <span
                                                                    key={t}
                                                                    className={`tag${on ? ' is-acc' : ''}`}
                                                                    role="checkbox"
                                                                    aria-checked={on}
                                                                    onClick={() => patchStream(s.key, { mask: on ? s.mask.filter(x => x !== t) : [...s.mask, t] })}
                                                                >
                                                                    {EVENT_NAMES[t] ?? t}
                                                                </span>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        {st && running && (
                                            <div className="sl-met">
                                                <div><span className="k">Кадров/с</span><span className="v">{fmt1(st.fps)}</span></div>
                                                <div><span className="k">Инференс</span><span className="v">{Math.round(st.infer_ms)}<small>мс</small></span></div>
                                                <div><span className="k">Ожидание</span><span className={`v${st.wait_ms > st.infer_ms ? ' warn' : ''}`}>{Math.round(st.wait_ms)}<small>мс</small></span></div>
                                                <div><span className="k">Глубина</span><span className={`v${st.depth_actual < st.depth ? ' warn' : ''}`}>{st.depth_actual}<small>из {st.depth}</small></span></div>
                                                <div><span className="k">Отброшено</span><span className={`v${st.dropped > 0 ? ' warn' : ''}`}>{st.dropped}</span></div>
                                                <div><span className="k">Треков</span><span className="v">{st.tracks}</span></div>
                                            </div>
                                        )}
                                        {st?.model && (
                                            <div className="sl-model">
                                                <span className="seps">
                                                    <span>{st.model.input_width}×{st.model.input_height}</span>
                                                    <span>{st.model.quantized ? 'int8' : 'fp16'}</span>
                                                    <span className="tag" data-tip={st.layout}>{layoutName(st.layout)}</span>
                                                    <span>{st.model.class_count} {plural(st.model.class_count, 'класс', 'класса', 'классов')}</span>
                                                </span>
                                                <span className="spacer" />
                                                <span className="dim">{fmtMb(st.model.weight_bytes)}</span>
                                            </div>
                                        )}
                                        {error && (
                                            <div className="err-line">
                                                <Icon name="warn" className="ico" />
                                                {error.code != null && <span className="num">{error.code}</span>}
                                                <span className="seps">
                                                    <span>{error.text}</span>
                                                    {error.detail && error.text !== error.detail && <span>{error.detail}</span>}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            <div className="card sl-add">
                                <div className="empty">
                                    <Icon name="plus" className="ico" />
                                    <b>Добавить поток</b>
                                    <button className="btn btn--sm btn--acc" disabled={configs.length === 0} onClick={() => addStream()}>Добавить</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <aside className="nv-cat">
                    <div className="eyebrow">Конфигурации — {configs.length}</div>
                    {configs.map(c => {
                        const used = streams.filter(s => s.configId === c.id).length;
                        return (
                            <button key={c.id} className="row-item" onClick={() => addStream(c.id)}>
                                <span className="chip-col" style={{ background: used ? 'var(--acc)' : 'var(--line-hi)' }} />
                                <div className="t">
                                    <b>{c.name || c.id}</b>
                                    <span className="seps">
                                        <span>{classCount[c.id] ?? 0} {plural(classCount[c.id] ?? 0, 'класс', 'класса', 'классов')}</span>
                                        {trackerBy[c.id] && <span>трекер</span>}
                                    </span>
                                </div>
                                {used > 0 && <span className="tag is-acc">×{used}</span>}
                                <Icon name="plus" className="ico" />
                            </button>
                        );
                    })}
                    {configs.length === 0 && <div className="hint">Конфигураций нет</div>}
                </aside>
            </div>
        </>
    );
}

// Целое число с коммитом по blur/Enter
function IntField({ label, value, min, onCommit }: { label: string; value: number; min: number; onCommit: (v: number) => void }) {
    const [text, setText] = useState(String(value));
    const [focused, setFocused] = useState(false);
    useEffect(() => { if (!focused) setText(String(value)); }, [value, focused]);

    const commit = () => {
        const n = Math.max(min, Math.round(Number(text)));
        if (!Number.isFinite(n)) { setText(String(value)); return; }
        setText(String(n));
        if (n !== value) onCommit(n);
    };

    return (
        <div className="tf">
            <span className="tf-cap">{label}</span>
            <input
                className="tf-in"
                type="number"
                min={min}
                step={1}
                value={text}
                onChange={e => setText(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => { setFocused(false); commit(); }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                onWheel={e => e.currentTarget.blur()}
            />
        </div>
    );
}
