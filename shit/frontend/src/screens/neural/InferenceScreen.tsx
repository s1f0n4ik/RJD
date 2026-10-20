import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Switch } from '../../app/Modal';
import { Select } from '../../app/Select';
import { describeError } from '../../components/webrtc/error-codes';
import { useToast } from '../../app/Toast';
import { neuralApi } from '../../features/neural/api/client';
import type { ActiveDesc, ConfigSummary, ModelDesc, SlotStatus, StreamingDesc, TileState, VideoStream } from '../../features/neural/api/types';
import { modelClasses, modelQuant, modelSize, plural } from './model-desc';

/** Слот на доске: пара видеопоток + конфигурация, глубина и потолок к/с, вывод полотна с рамками, маска событий */
interface Slot {
    key: string;
    streamId: string | null;
    configId: string | null;
    depth: number;
    fps: number;
    streaming: StreamingDesc;
    // События снимка кадра камеры
    image: string[];
}

// Умолчание маски снимка, как в media-center
const DEFAULT_IMAGE = ['confirmed'];

const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter(x => x !== item) : [...list, item]);

// Названия событий трека — идентификаторы приходят с бэкенда
const EVENT_NAMES: Record<string, string> = {
    created: 'Создан', confirmed: 'Подтверждён', updated: 'Движение',
    lost: 'Потерян', recovered: 'Восстановлен', removed: 'Удалён',
    zone_up: 'Вход в зону выше',
};
// Пункт маски снимка, которому нужны зоны конфигурации
const ZONE_UP = 'zone_up';
const FALLBACK_EVENTS = ['created', 'confirmed', 'updated', 'lost', 'recovered', 'removed'];

const TILE_STATE_TIP: Record<TileState, string> = {
    ok: 'Кадр идёт',
    no_camera: 'Камеры нет в хранилище — тайл уходит в модель серым',
    stalled: 'Кадр замёрз — тайл уходит в модель серым',
};

const clone = (s: Slot[]): Slot[] => s.map(x => ({ ...x, image: [...x.image], streaming: { ...x.streaming } }));

const fmtMb = (bytes: number) => `${(bytes / (1 << 20)).toFixed(1)} МБ`;
const tilesText = (n: number) => `${n} ${plural(n, 'тайл', 'тайла', 'тайлов')}`;

// Что конфигурации нужно от слота: трекер для снимков и число зон
interface ConfigExtras {
    tracker: boolean;
    zones: number;
}

// Бэкенд отдаёт раскладку описательной фразой (output_layout_name), в строке модели нужно короткое имя
const layoutName = (layout: string): string => {
    const l = layout.toLowerCase();
    if (l.includes('masks')) return l.startsWith('split') ? 'SPLIT_LEVELS_SEG' : 'SINGLE_SEG';
    if (l.startsWith('single')) return 'SINGLE';
    if (l.startsWith('split')) return 'SPLIT_LEVELS';
    return layout.toUpperCase();
};
const fmt1 = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

interface InferenceScreenProps {
    status: SlotStatus[] | null;
    onRefreshStatus: () => void;
}

export function InferenceScreen({ status, onRefreshStatus }: InferenceScreenProps) {
    const toast = useToast();

    const [configs, setConfigs] = useState<ConfigSummary[]>([]);
    const [extras, setExtras] = useState<Record<string, ConfigExtras>>({});
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
            configId: d.config_id || null,
            depth: Math.max(1, d.depth ?? 1),
            fps: Math.max(1, d.fps ?? 10),
            streaming: d.streaming ?? { enabled: false, name: '' },
            image: d.image_mask ?? DEFAULT_IMAGE,
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
                return [c.id, { tracker: !!full.tracker, zones: full.zones?.length ?? 0 }] as const;
            } catch {
                return [c.id, { tracker: false, zones: 0 }] as const;
            }
        }));
        setExtras(Object.fromEntries(entries));
    }, []);

    useEffect(() => {
        neuralApi.getEventTypes().then(r => r.events?.length && setEventTypes(r.events.map(e => e.type))).catch(() => {});
        neuralApi.listStreams().then(r => setVideos(r.streams ?? [])).catch(() => setVideos([]));
        reloadConfigs().catch(e => setErr(e instanceof Error ? e.message : String(e)));
        reloadState();
    }, [reloadConfigs, reloadState]);

    const dirty = useMemo(() => JSON.stringify(slots) !== JSON.stringify(saved), [slots, saved]);
    const anyRunning = status?.some(s => s.running) ?? false;

    const videoOf = (id: string | null) => (id ? videos.find(v => v.id === id) ?? null : null);
    const configOf = (id: string | null) => (id ? configs.find(c => c.id === id) ?? null : null);
    const statusOf = (s: Slot): SlotStatus | null =>
        (s.streamId && s.configId ? status?.find(st => st.stream_id === s.streamId && st.config_id === s.configId) ?? null : null);
    // Вход модели не совпадает с полотном потока
    const misfit = (v: VideoStream | null, m: ModelDesc | null | undefined) =>
        !!v && !!m && (m.input_width !== v.width || m.input_height !== v.height);

    // Ту же пару поток + конфигурация в двух слотах бэкенд отвергает целиком
    const duplicateKeys = useMemo(() => {
        const seen = new Map<string, string>();
        const dups = new Set<string>();
        for (const s of slots) {
            if (!s.streamId || !s.configId) continue;
            const pair = `${s.streamId}/${s.configId}`;
            const first = seen.get(pair);
            if (first) { dups.add(first); dups.add(s.key); } else seen.set(pair, s.key);
        }
        return dups;
    }, [slots]);

    const problem = useMemo(() => {
        for (const s of slots) {
            if (!s.streamId) return 'Слот без видеопотока';
            if (!s.configId) return 'Слот без конфигурации';
            const c = configOf(s.configId), v = videoOf(s.streamId);
            if (!c) return `Конфигурация «${s.configId}» удалена`;
            if (!c.model) return `«${c.name || c.id}»: модель не прочитана`;
            if (misfit(v, c.model)) return `«${c.name || c.id}»: модель ждёт ${modelSize(c.model)}, полотно ${v!.width}×${v!.height}`;
        }
        if (duplicateKeys.size) return 'Одна пара поток + конфигурация в двух слотах';
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slots, duplicateKeys, videos, configs]);

    const patchSlot = (key: string, p: Partial<Slot>) =>
        setSlots(list => list.map(s => (s.key === key ? { ...s, ...p } : s)));

    // Конфигурация нового слота — первая с моделью под полотно, которой ещё нет на этом потоке
    const fitConfig = (streamId: string | null): string | null => {
        const v = videoOf(streamId);
        if (!v) return null;
        return configs.find(c => c.model && !misfit(v, c.model) && !slots.some(s => s.streamId === v.id && s.configId === c.id))?.id ?? null;
    };

    const addSlot = (streamId: string | null = null) =>
        setSlots(list => [...list, { key: uid(), streamId, configId: fitConfig(streamId), depth: 1, fps: 10, streaming: { enabled: false, name: '' }, image: DEFAULT_IMAGE }]);

    const removeSlot = (key: string) => setSlots(list => list.filter(s => s.key !== key));

    const toDesc = (s: Slot): ActiveDesc => ({
        stream_id: s.streamId ?? '',
        config_id: s.configId ?? '',
        depth: s.depth,
        fps: s.fps,
        streaming: { enabled: s.streaming.enabled, name: s.streaming.name },
        image_mask: s.image,
    });

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
        hint: `${v.width}×${v.height} · ${tilesText(v.tiles.length)}`,
    }));

    // Конфигурации слота: модель не под полотно, не прочитана или пара уже стоит — выбрать нельзя
    const configOptions = (s: Slot) => {
        const v = videoOf(s.streamId);
        return configs.map(c => {
            const m = c.model;
            const taken = slots.find(o => o.key !== s.key && o.streamId === s.streamId && o.configId === c.id);
            const hint = !m ? 'модель не прочитана'
                : misfit(v, m) ? `модель ждёт ${modelSize(m)}, полотно ${v!.width}×${v!.height}`
                    : taken ? `пара уже в слоте ${slots.indexOf(taken) + 1}`
                        : `${c.id} · ${modelSize(m)} · ${modelQuant(m)}`;
            return { value: c.id, label: c.name || c.id, hint, disabled: c.id !== s.configId && (!m || misfit(v, m) || !!taken) };
        });
    };

    return (
        <>
            <div className="filters">
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
                                const c = configOf(s.configId);
                                const ex = s.configId ? extras[s.configId] : undefined;
                                const running = !!st?.running;
                                const dup = duplicateKeys.has(s.key);
                                // Модель не под полотно: слот с такой парой бэкенд не поставит
                                const wrong = misfit(v, c?.model);
                                const failed = wrong || (!!st && !st.running && st.code !== 0);
                                const error = !wrong && failed ? describeError({ code: st!.code, description: st!.error }) : null;
                                // Модель работающего слота, иначе описание из конфигурации
                                const model = st?.model
                                    ? { size: `${st.model.input_width}×${st.model.input_height}`, quant: st.model.quantized ? 'int8' : 'fp16', layout: layoutName(st.layout), tip: st.layout, classes: st.model.class_count, bytes: st.model.weight_bytes }
                                    : c?.model ? { size: modelSize(c.model), quant: modelQuant(c.model), layout: c.model.layout, tip: c.model.layout, classes: c.model.class_count, bytes: c.model.weight_bytes } : null;
                                const events = eventTypes.filter(t => t !== ZONE_UP || !!ex?.zones);
                                // Состояние тайлов — из статуса работающего слота, иначе по списку тайлов потока
                                const tiles = st?.tiles?.length ? st.tiles.map(t => ({ camera: t.camera, state: t.state as TileState | null }))
                                    : (v?.tiles ?? []).map(t => ({ camera: t.camera, state: null as TileState | null }));
                                return (
                                    <div key={s.key} className={`card sl-card${failed ? ' is-err' : running ? ' is-run' : ''}`}>
                                        <div className="card-h">
                                            <span className="sl-title">
                                                <h3>{v ? v.name || v.id : 'Новый слот'}</h3>
                                                {c && <span>{c.name || c.id}</span>}
                                            </span>
                                            {!st
                                                ? <span className="tag is-warn">не применён</span>
                                                : running
                                                    ? <span className="tag is-ok">работает</span>
                                                    : <span className={`tag${failed ? ' is-err' : ''}`}>остановлен</span>}
                                            <button className="icon-btn" data-tip="Убрать слот" onClick={() => removeSlot(s.key)}><Icon name="trash" size={13} /></button>
                                        </div>
                                        <div className="card-b">
                                            <div className="tf">
                                                <span className="tf-cap">Видеопоток{dup && <span className="spacer" style={{ color: 'var(--err)' }}>дубль</span>}</span>
                                                <Select
                                                    value={s.streamId ?? ''}
                                                    options={videoOptions}
                                                    onChange={id => patchSlot(s.key, { streamId: id })}
                                                    placeholder="Не выбран"
                                                    emptyText="Видеопотоков нет — создайте их в разделе «Видеопотоки»"
                                                />
                                            </div>
                                            <div className="tf">
                                                <span className="tf-cap">Конфигурация{wrong && <span className="w">модель ждёт {modelSize(c!.model!)}</span>}</span>
                                                <Select
                                                    value={c ? c.id : ''}
                                                    options={configOptions(s)}
                                                    onChange={id => patchSlot(s.key, { configId: id })}
                                                    placeholder={s.configId ? 'Конфигурация удалена' : 'Не выбрана'}
                                                    emptyText="Конфигураций нет — создайте их в разделе «Нейросети»"
                                                />
                                            </div>
                                            {v && (
                                                <div className="sl-src">
                                                    <span className="seps">
                                                        <span>{v.width}×{v.height}</span>
                                                        <span>{tilesText(v.tiles.length)}</span>
                                                    </span>
                                                    <div className="sl-tl">
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
                                            {ex?.tracker && (
                                                <div className="sl-ev">
                                                    <div className="tf">
                                                        <span className="tf-cap">Снимок на событие</span>
                                                        <div className="evs">
                                                            {events.map(t => {
                                                                const on = s.image.includes(t);
                                                                return (
                                                                    <span
                                                                        key={t}
                                                                        className={`tag${on ? ' is-acc' : ''}`}
                                                                        role="checkbox"
                                                                        aria-checked={on}
                                                                        onClick={() => patchSlot(s.key, { image: toggle(s.image, t) })}
                                                                    >
                                                                        {EVENT_NAMES[t] ?? t}
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
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
                                        {model && (
                                            <div className="sl-model">
                                                <span className="seps">
                                                    <span className={wrong ? 'w' : undefined}>{model.size}</span>
                                                    <span>{model.quant}</span>
                                                    <span className="tag" data-tip={model.tip}>{model.layout}</span>
                                                    <span>{modelClasses(model.classes)}</span>
                                                </span>
                                                <span className="spacer" />
                                                <span className="dim">{fmtMb(model.bytes)}</span>
                                            </div>
                                        )}
                                        {wrong && (
                                            <div className="err-line">
                                                <Icon name="warn" className="ico" />
                                                <span className="seps"><span>модель ждёт {modelSize(c!.model!)}</span><span>полотно {v!.width}×{v!.height}</span></span>
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
                    {videos.map(v => {
                        const used = slots.filter(s => s.streamId === v.id).length;
                        return (
                            <button key={v.id} className="row-item" onClick={() => addSlot(v.id)}>
                                <div className="t">
                                    <b>{v.name || v.id}</b>
                                    <span>{v.width}×{v.height} · {tilesText(v.tiles.length)} · {[...new Set(v.tiles.map(t => t.camera))].join(', ')}</span>
                                </div>
                                {used > 0 && <span className="tag is-acc">×{used}</span>}
                                <Icon name="plus" className="ico" />
                            </button>
                        );
                    })}
                    {videos.length === 0 && <div className="hint">Видеопотоков нет</div>}
                    <div className="hint">Клик добавляет слот на этом видеопотоке; конфигурация — первая с моделью под полотно</div>
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
