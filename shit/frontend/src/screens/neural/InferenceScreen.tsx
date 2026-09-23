import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Switch } from '../../app/Modal';
import { Select } from '../../app/Select';
import { describeError } from '../../components/webrtc/error-codes';
import { useToast } from '../../features/birdview/components/common/Toast';
import { neuralApi } from '../../features/neural/api/client';
import type { ActiveDesc, ConfigSummary, SlotStatus, StreamingDesc, SystemInfo, TileState, VideoStream } from '../../features/neural/api/types';

/** Слот на доске: видеопоток, глубина и потолок к/с, вывод полотна с рамками, маска событий */
interface Slot {
    key: string;
    streamId: string | null;
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

const TILE_STATE_TIP: Record<TileState, string> = {
    ok: 'Кадр идёт',
    no_camera: 'Камеры нет в хранилище — тайл уходит в модель серым',
    stalled: 'Кадр замёрз — тайл уходит в модель серым',
};

const clone = (s: Slot[]): Slot[] => s.map(x => ({ ...x, mask: [...x.mask], streaming: { ...x.streaming } }));

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

interface InferenceScreenProps {
    status: SlotStatus[] | null;
    onRefreshStatus: () => void;
}

export function InferenceScreen({ status, onRefreshStatus }: InferenceScreenProps) {
    const toast = useToast();

    const [system, setSystem] = useState<SystemInfo>(DEFAULT_SYSTEM);
    const [configs, setConfigs] = useState<ConfigSummary[]>([]);
    const [trackerBy, setTrackerBy] = useState<Record<string, boolean>>({});
    const [videos, setVideos] = useState<VideoStream[]>([]);
    const [eventTypes, setEventTypes] = useState<string[]>(FALLBACK_EVENTS);
    const [slots, setSlots] = useState<Slot[]>([]);
    const [saved, setSaved] = useState<Slot[]>([]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const nextKey = useRef(1);
    const uid = () => `s${nextKey.current++}`;

    const reloadState = useCallback(async () => {
        const descs = await neuralApi.getState().catch(() => [] as ActiveDesc[]);
        const list: Slot[] = descs.map(d => ({
            key: uid(),
            streamId: d.stream_id || null,
            depth: Math.max(1, d.depth ?? 1),
            fps: Math.max(1, d.fps ?? 10),
            streaming: d.streaming ?? { enabled: false, name: '' },
            mask: d.event_mask ?? [],
        }));
        setSlots(clone(list));
        setSaved(clone(list));
    }, []);

    const reloadConfigs = useCallback(async () => {
        const { configurations } = await neuralApi.listConfigurations();
        setConfigs(configurations);
        const entries = await Promise.all(configurations.map(async c => {
            try {
                const full = await neuralApi.getConfiguration(c.id);
                return [c.id, !!full.tracker] as const;
            } catch {
                return [c.id, false] as const;
            }
        }));
        setTrackerBy(Object.fromEntries(entries));
    }, []);

    useEffect(() => {
        neuralApi.getSystem().then(setSystem).catch(() => setSystem(DEFAULT_SYSTEM));
        neuralApi.getEventTypes().then(r => r.events?.length && setEventTypes(r.events.map(e => e.type))).catch(() => {});
        neuralApi.listStreams().then(r => setVideos(r.streams ?? [])).catch(() => setVideos([]));
        reloadConfigs().catch(e => setErr(e instanceof Error ? e.message : String(e)));
        reloadState();
    }, [reloadConfigs, reloadState]);

    const dirty = useMemo(() => JSON.stringify(slots) !== JSON.stringify(saved), [slots, saved]);
    const anyRunning = status?.some(s => s.running) ?? false;

    const videoOf = (id: string | null) => (id ? videos.find(v => v.id === id) ?? null : null);
    const configName = (id: string) => configs.find(c => c.id === id)?.name || id;
    // Конфигурация видеопотока удалена или ещё не назначена
    const orphan = (v: VideoStream) => !v.config_id || !configs.some(c => c.id === v.config_id);
    const statusOf = (s: Slot): SlotStatus | null => (s.streamId ? status?.find(st => st.stream_id === s.streamId) ?? null : null);

    // Один видеопоток в двух слотах бэкенд отвергает целиком
    const duplicateKeys = useMemo(() => {
        const seen = new Map<string, string>();
        const dups = new Set<string>();
        for (const s of slots) {
            if (!s.streamId) continue;
            const first = seen.get(s.streamId);
            if (first) { dups.add(first); dups.add(s.key); } else seen.set(s.streamId, s.key);
        }
        return dups;
    }, [slots]);

    const problem = useMemo(() => {
        for (const s of slots) {
            if (!s.streamId) return 'Слот без видеопотока';
            const v = videoOf(s.streamId);
            if (v && orphan(v)) return `Видеопоток «${v.name || v.id}»: конфигурация удалена`;
        }
        if (duplicateKeys.size) return 'Один видеопоток в двух слотах';
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slots, duplicateKeys, videos, configs]);

    const patchSlot = (key: string, p: Partial<Slot>) =>
        setSlots(list => list.map(s => (s.key === key ? { ...s, ...p } : s)));

    const addSlot = (streamId: string | null = null) =>
        setSlots(list => [...list, { key: uid(), streamId, depth: 1, fps: 10, streaming: { enabled: false, name: '' }, mask: [] }]);

    const removeSlot = (key: string) => setSlots(list => list.filter(s => s.key !== key));

    const toDesc = (s: Slot): ActiveDesc => {
        const v = videoOf(s.streamId);
        return {
            stream_id: s.streamId ?? '',
            depth: s.depth,
            fps: s.fps,
            streaming: { enabled: s.streaming.enabled, name: s.streaming.name },
            event_mask: v && trackerBy[v.config_id] ? s.mask : [],
        };
    };

    const apply = async () => {
        if (problem) { setErr(problem); return; }
        setBusy(true);
        setErr(null);
        try {
            await neuralApi.setState(slots.map(toDesc));
            setSaved(clone(slots));
            toast('Слоты применены', `${slots.length} ${plural(slots.length, 'слот', 'слота', 'слотов')}`, 'ok');
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

    const videoOptions = videos.map(v => ({
        value: v.id,
        label: v.name || v.id,
        hint: `${orphan(v) ? 'конфигурация удалена' : configName(v.config_id)} · ${v.tiles.length} ${plural(v.tiles.length, 'тайл', 'тайла', 'тайлов')}`,
    }));

    // Каталог: видеопотоки по конфигурациям, потоки без конфигурации отдельной группой
    const groups = useMemo(() => {
        const out: { id: string; title: string; items: VideoStream[]; dead: boolean }[] =
            configs.map(c => ({ id: c.id, title: c.name || c.id, items: videos.filter(v => v.config_id === c.id), dead: false }));
        const lost = videos.filter(orphan);
        if (lost.length) out.push({ id: '', title: 'конфигурация удалена', items: lost, dead: true });
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [configs, videos]);

    return (
        <>
            <div className="filters">
                <span className="fld"><span className="k">Платформа</span><span className="v">{system.label}</span></span>
                <span className="fld"><span className="k">Ядер NPU</span><span className="v">{system.npu_cores}</span></span>
                <span className="fld"><span className="k">Слотов</span><span className="v">{slots.length}</span></span>
                {dirty && <span className="tag is-warn">изменения не применены</span>}
                {err && <span className="tag is-err">{err}</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                    {status === null
                        ? <span className="pill err"><span className="dot" />нет ответа</span>
                        : anyRunning
                            ? <span className="pill ok"><span className="dot" />обработка идёт</span>
                            : <span className="pill"><span className="dot" />остановлено</span>}
                    <button className="btn" disabled={busy || !dirty} onClick={() => { setSlots(clone(saved)); setErr(null); }}>Сбросить</button>
                    <button className="btn btn--acc" disabled={busy || !dirty} onClick={apply}>Применить</button>
                    <span className="tbar-sep" />
                    {anyRunning ? (
                        <>
                            <button className="btn" disabled={busy} data-tip="Перезапустить все слоты" onClick={() => control('restart')}><Icon name="refresh" className="ico" /></button>
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
                            {slots.map(s => {
                                const st = statusOf(s);
                                const v = videoOf(s.streamId);
                                const hasTracker = !!v && !!trackerBy[v.config_id];
                                const running = !!st?.running;
                                const failed = !!st && !st.running && st.code !== 0;
                                const dup = duplicateKeys.has(s.key);
                                const error = failed ? describeError({ code: st!.code, description: st!.error }) : null;
                                // Состояние тайлов — из статуса работающего слота, иначе по списку тайлов потока
                                const tiles = st?.tiles?.length ? st.tiles.map(t => ({ camera: t.camera, state: t.state as TileState | null }))
                                    : (v?.tiles ?? []).map(t => ({ camera: t.camera, state: null as TileState | null }));
                                return (
                                    <div key={s.key} className={`card sl-card${running ? ' is-run' : failed ? ' is-err' : ''}`}>
                                        <div className="card-h">
                                            <h3>{v ? v.name || v.id : 'Новый слот'}</h3>
                                            {!st
                                                ? <span className="tag is-warn">не применён</span>
                                                : running
                                                    ? <span className="tag is-ok">работает</span>
                                                    : <span className={`tag${failed ? ' is-err' : ''}`}>остановлен</span>}
                                            <button className="icon-btn spacer" data-tip="Убрать слот" onClick={() => removeSlot(s.key)}><Icon name="trash" size={13} /></button>
                                        </div>
                                        <div className="card-b">
                                            <div className="tf">
                                                <span className="tf-cap">Видеопоток{dup && <span className="spacer" style={{ color: 'var(--err)' }}>дубль</span>}</span>
                                                <Select
                                                    value={s.streamId ?? ''}
                                                    options={videoOptions}
                                                    onChange={id => patchSlot(s.key, { streamId: id, mask: trackerBy[videoOf(id)?.config_id ?? ''] ? s.mask : [] })}
                                                    placeholder="Не выбран"
                                                    emptyText="Видеопотоков нет — создайте их в разделе «Видеопотоки»"
                                                />
                                            </div>
                                            {v && (
                                                <div className="sl-src">
                                                    <span className="seps">
                                                        {orphan(v) ? <span className="bad">конфигурация удалена</span> : <span>{configName(v.config_id)}</span>}
                                                        <span>{v.width}×{v.height}</span>
                                                        <span>{v.tiles.length} {plural(v.tiles.length, 'тайл', 'тайла', 'тайлов')}</span>
                                                    </span>
                                                    <div className="tl">
                                                        {tiles.map((t, i) => (
                                                            <span key={i} className={`t${t.state && t.state !== 'ok' ? ' is-err' : ''}${t.state ? '' : ' is-idle'}`} data-tip={t.state ? TILE_STATE_TIP[t.state] : undefined}>
                                                                <i />{t.camera}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            <div className="tf-row">
                                                <IntField label="Глубина" value={s.depth} min={1} onCommit={n => patchSlot(s.key, { depth: n })} />
                                                <IntField label="Кадров/с" value={s.fps} min={1} onCommit={n => patchSlot(s.key, { fps: n })} />
                                            </div>
                                            <Switch on={s.streaming.enabled} onToggle={on => patchSlot(s.key, { streaming: { ...s.streaming, enabled: on } })}>
                                                Выводить полотно с рамками
                                            </Switch>
                                            {s.streaming.enabled && (
                                                <div className="tf">
                                                    <span className="tf-cap">Имя вывода</span>
                                                    <input className="tf-in" value={s.streaming.name} placeholder={v ? `${v.name || v.id} с рамками` : ''}
                                                        onChange={e => patchSlot(s.key, { streaming: { ...s.streaming, name: e.target.value } })} />
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
                                                                    onClick={() => patchSlot(s.key, { mask: on ? s.mask.filter(x => x !== t) : [...s.mask, t] })}
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

                            <button type="button" className="card sl-add" disabled={videos.length === 0} onClick={() => addSlot()}>
                                <div className="empty">
                                    <Icon name="plus" className="ico" />
                                    <b>Добавить слот</b>
                                </div>
                            </button>
                        </div>
                    </div>
                </div>

                <aside className="nv-cat">
                    <div className="eyebrow">Видеопотоки — {videos.length}</div>
                    {groups.map(g => (
                        <div key={g.id || 'lost'} className="sl-grp">
                            <div className={`grp-cap${g.dead ? ' is-err' : ''}`}>{g.title}</div>
                            {g.items.map(v => {
                                const used = slots.filter(s => s.streamId === v.id).length;
                                return (
                                    <button key={v.id} className="row-item" disabled={g.dead} onClick={() => addSlot(v.id)}
                                        data-tip={g.dead ? 'Назначьте конфигурацию в редакторе видеопотока' : undefined}>
                                        <div className="t">
                                            <b>{v.name || v.id}</b>
                                            <span>{v.tiles.length} {plural(v.tiles.length, 'тайл', 'тайла', 'тайлов')} · {[...new Set(v.tiles.map(t => t.camera))].join(', ')}</span>
                                        </div>
                                        {used > 0 && <span className="tag is-acc">×{used}</span>}
                                        {!g.dead && <Icon name="plus" className="ico" />}
                                    </button>
                                );
                            })}
                            {g.items.length === 0 && <div className="hint">Видеопотоков нет</div>}
                        </div>
                    ))}
                    {videos.length === 0 && configs.length === 0 && <div className="hint">Конфигураций нет</div>}
                    <div className="hint">Клик добавляет слот на этом видеопотоке; конфигурация — из потока</div>
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
