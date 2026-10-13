import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { useNeuralStatus } from '../../app/neuralStatus';
import { listAllConfigurations, neuralApi } from '../../features/neural/api/client';
import { getDevices } from '../../services/devices';
import { configurationsApi, dictionariesOf, isIskraTable, type CfItem, type CfLink, type CfRules, type CfState, type RulesSettings } from './api';
import {
    CanCard, ClassPicker, FeedTable, MasterEnvCard, ModbusCard, MODULE_SHORT, StitchCard, WebSocketCard,
    countDiff, type CameraRef, type ClassCatalog,
} from './RulesPanels';
import {
    DictionariesPanel, IskraTablePanel, RsmTablePanel, settingsError, tableUsage, type NeuralModel, type RunningMap,
} from './TablePanels';
import './configurations.css';

const POLL_MS = 3000;
const LINK_POLL_MS = 2000;
interface ToastState {
    text: string;
    tone: 'ok' | 'err';
}

type PickModule = 'websocket' | 'can';

// Конфигурации нейросети всех плат: классы по id, суперклассы по месту в списке
async function loadModels(): Promise<NeuralModel[]> {
    const configs = await listAllConfigurations();
    const metas = await Promise.all(configs.map(c =>
        Promise.all([neuralApi.getClasses(c.id, c.device), neuralApi.getSuperclasses(c.id, c.device)]).catch(() => null)));
    return configs.flatMap((c, i) => {
        const m = metas[i];
        if (!m) return [];
        return [{
            id: c.id,
            name: c.name || c.id,
            classes: (m[0].classes ?? [])
                .map(x => ({ id: Number(x.id), name: x.name, superclass: x.superclass ?? '' }))
                .sort((a, b) => a.id - b.id),
            superclasses: (m[1].superclasses ?? []).map(s => ({ key: s.key, name: s.name, color: s.color ?? '' })),
        }];
    });
}

// Суперклассы и классы всех конфигураций по имени — для фильтров модулей
function catalogOf(models: NeuralModel[]): ClassCatalog {
    const sc = new Map<string, { key: string; name: string; count: number; color: string }>();
    const cls = new Map<string, { name: string; superclass: string }>();
    models.forEach(m => {
        m.superclasses.forEach(s => { if (!sc.has(s.key)) sc.set(s.key, { ...s, count: 0 }); });
        m.classes.forEach(c => { if (!cls.has(c.name)) cls.set(c.name, { name: c.name, superclass: c.superclass }); });
    });
    cls.forEach(c => { const s = sc.get(c.superclass); if (s) s.count += 1; });
    return { superclasses: [...sc.values()], classes: [...cls.values()] };
}

// Прошедшее время: «42 с», «5 мин», «2 ч 14 мин»
function since(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s} с`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} мин`;
    return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

const clone = (s: RulesSettings): RulesSettings => JSON.parse(JSON.stringify(s));
const savedLabel = (ms: number | null) =>
    ms ? `сохранено ${new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'умолчания';

function Metrics({ rows }: { rows: [string, string, string?][] }) {
    return (
        <div className="cr-met">
            {rows.map(([k, v, tone], i) => (
                <Fragment key={i}><span>{k}</span><span className={tone}>{v}</span></Fragment>
            ))}
        </div>
    );
}

export default function ConfigurationsScreen() {
    const navigate = useNavigate();
    const section = useParams().section;
    const tableView = section === 'table';
    const dictView = section === 'dict';
    const [state, setState] = useState<CfState | null>(null);
    const [failed, setFailed] = useState(false);
    const [link, setLink] = useState<CfLink | null>(null);
    const [sel, setSel] = useState('');
    const [node, setNode] = useState('master');
    const [rules, setRules] = useState<CfRules | null>(null);
    const [rulesError, setRulesError] = useState('');
    const [draft, setDraft] = useState<RulesSettings | null>(null);
    const [models, setModels] = useState<NeuralModel[]>([]);
    const catalog = useMemo(() => catalogOf(models), [models]);
    const neural = useNeuralStatus();
    const [cameras, setCameras] = useState<CameraRef[]>([]);
    const [pick, setPick] = useState<PickModule | null>(null);
    const [pending, setPending] = useState<CfItem | null>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<ToastState | null>(null);
    const toastTimer = useRef<number | null>(null);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            if (toastTimer.current) window.clearTimeout(toastTimer.current);
        };
    }, []);

    const showToast = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
        setToast({ text, tone });
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 4500);
    }, []);

    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const s = await configurationsApi.list();
                if (!stop && alive.current) {
                    setState(s);
                    setFailed(false);
                }
            } catch {
                if (!stop && alive.current) setFailed(true);
            }
        };
        tick();
        const t = setInterval(tick, POLL_MS);
        return () => {
            stop = true;
            clearInterval(t);
        };
    }, []);

    // Связь и лента — пока экран открыт
    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const l = await configurationsApi.link();
                if (!stop && alive.current) setLink(l);
            } catch {
                if (!stop && alive.current) setLink(null);
            }
        };
        tick();
        const t = setInterval(tick, LINK_POLL_MS);
        return () => {
            stop = true;
            clearInterval(t);
        };
    }, []);

    useEffect(() => {
        loadModels().then(m => { if (alive.current) setModels(m); }).catch(() => { /* выбор классов покажет пустые списки */ });
        neuralApi.listCameras()
            .then(r => {
                if (!alive.current) return;
                setCameras(Object.entries(r.cameras ?? {}).map(([id, c]) => ({ id, name: c.display_name || id, device: c.device_name ?? '' })));
            })
            .catch(() => { /* роли покажут только сохранённые камеры */ });
    }, []);

    const items = state?.items ?? [];
    const active = items.find(i => i.active) ?? null;
    const item = items.find(i => i.id === sel) ?? active ?? items[0] ?? null;
    const itemId = item?.id ?? '';

    // Настройки выбранной конфигурации; несохранённая правка при смене конфигурации теряется
    useEffect(() => {
        if (!itemId) return;
        let stop = false;
        setNode('master');
        setRules(null);
        setDraft(null);
        setRulesError('');
        configurationsApi.getRules(itemId)
            .then(r => {
                if (stop || !alive.current) return;
                setRules(r);
                setDraft(clone(r.settings));
            })
            .catch(e => {
                if (!stop && alive.current) setRulesError(e instanceof Error && e.message.startsWith('404') ? 'Нет правил мастера' : 'Мастер обнаружений не отвечает');
            });
        return () => {
            stop = true;
        };
    }, [itemId]);

    const dirty = rules && draft ? countDiff(draft, rules.settings) : 0;
    const tableError = settingsError(draft?.dictionaries);

    // Конфигурация нейросети → платы, где её слот запущен
    const running = useMemo(() => {
        const map: RunningMap = new Map();
        (neural ?? []).forEach(d => (d.slots ?? []).forEach(s => {
            const on = map.get(s.config_id) ?? [];
            if (s.running && !on.includes(d.device_name)) map.set(s.config_id, [...on, d.device_name]);
        }));
        return map;
    }, [neural]);

    const save = async () => {
        if (!draft || !item) return;
        setBusy(true);
        try {
            const r = await configurationsApi.saveRules(item.id, draft);
            if (alive.current) {
                setRules(r);
                setDraft(clone(r.settings));
                showToast('Настройки сохранены');
            }
        } catch (e) {
            if (alive.current) showToast(e instanceof Error ? e.message : 'Ошибка запроса', 'err');
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const confirmSelect = async () => {
        if (!pending) return;
        const id = pending.id;
        setPending(null);
        setBusy(true);
        try {
            const s = await configurationsApi.select(id);
            if (alive.current) {
                setState(s);
                showToast('Конфигурация переключена');
            }
        } catch (e) {
            if (alive.current) showToast(e instanceof Error ? e.message : 'Ошибка запроса', 'err');
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const deviceNames = useMemo(() => new Map(getDevices().map(d => [d.id, d.name])), [link]);
    const cameraName = useCallback((id: string) => cameras.find(c => c.id === id)?.name ?? id, [cameras]);

    if (!state) {
        return (
            <section className="screen mod-screen cf-screen">
                {failed ? (
                    <div className="notice">
                        <Icon name="warn" className="ico" />
                        <h2>Конфигурации недоступны</h2>
                        <p>Сервер мастера не отвечает</p>
                    </div>
                ) : (
                    <div className="mod-loading"><span className="spin" /></div>
                )}
            </section>
        );
    }

    const master = state.master;
    const live = !!item?.active && !!link;
    const off = !item?.active;
    const gwUp = !!link?.gateway.connected;
    const devs = link?.devices ?? [];
    const online = devs.filter(d => d.connected);

    const devicesNode = (
        <div className={`cr-node${off ? ' is-off' : ''}`}>
            <div className="cr-node-t">
                <i className={`dot ${off || !link ? '' : online.length ? 'ok' : 'err'}`} />
                <b>Устройства</b>
                <span className="eyebrow">{online.length} из {devs.length}</span>
            </div>
            {off ? <Metrics rows={[['не активна', '']]} /> : devs.length === 0 ? <Metrics rows={[['нет пакетов', '']]} /> : (
                <Metrics rows={[
                    ...devs.slice(0, 3).map(d => [deviceNames.get(d.id) ?? d.id.slice(0, 8), d.connected ? `${d.packets_per_s} пак/с` : 'нет связи', d.connected ? undefined : 'is-err'] as [string, string, string?]),
                    ['задержка', `${Math.max(0, ...online.map(d => d.delay_ms))} мс`],
                ]} />
            )}
        </div>
    );

    const masterNode = (
        <button type="button" className={`cr-node${off ? ' is-off' : ''}${!off && !link ? ' is-err' : ''}${node === 'master' ? ' is-sel' : ''}`} onClick={() => setNode('master')}>
            <div className="cr-node-t">
                <i className={`dot ${off ? '' : link ? 'ok' : 'err'}`} />
                <b>Мастер</b>
                <span className="eyebrow">{rules?.title ?? item?.title}</span>
            </div>
            {off ? <Metrics rows={[['не активна', '']]} /> : !link ? <Metrics rows={[['не отвечает', '', 'is-err']]} /> : (
                <Metrics rows={[
                    ['треков', String(link.master.tracks)],
                    ['открыто обнаружений', String(link.master.open)],
                    ['за сессию', String(link.master.opened)],
                ]} />
            )}
        </button>
    );

    const gatewayNode = (
        <div className={`cr-node${off ? ' is-off' : ''}${live && !gwUp ? ' is-err' : ''}`}>
            <div className="cr-node-t">
                <i className={`dot ${off || !link ? '' : gwUp ? 'ok' : 'err'}`} />
                <b>Шлюз</b>
                <span className="eyebrow">gRPC</span>
            </div>
            {off || !link ? <Metrics rows={[[off ? 'не активна' : '—', '']]} /> : gwUp ? (
                <Metrics rows={[
                    ['очередь', `${link.gateway.queue} / ${link.gateway.queue_max}`],
                    ['отказов', String(link.gateway.rejected)],
                    ['на связи', since(link.gateway.connected_at)],
                ]} />
            ) : (
                <Metrics rows={[
                    ['нет связи', since(link.gateway.lost_at), 'is-err'],
                    ['адрес', link.gateway.address],
                ]} />
            )}
        </div>
    );

    const moduleNodes = (item?.modules ?? []).map(m => {
        const c = link?.counters[m.id];
        return (
            <button
                key={m.id}
                type="button"
                className={`cr-node${off ? ' is-off' : ''}${!off && m.connected === false ? ' is-err' : ''}${node === m.id ? ' is-sel' : ''}`}
                onClick={() => setNode(m.id)}
                data-tip={!off && !m.connected && m.error ? m.error : undefined}
            >
                <div className="cr-node-t">
                    <i className={`dot ${off ? '' : m.connected ? 'ok' : 'err'}`} />
                    <b>{MODULE_SHORT[m.id] ?? m.title}</b>
                    <span className="eyebrow">{m.transport}</span>
                </div>
                {c ? (
                    <Metrics rows={[
                        ['отправлено', String(c.sent)],
                        ['принято', String(c.accepted)],
                        ['отброшено фильтром', String(c.filtered)],
                    ]} />
                ) : <Metrics rows={[[off ? 'не активна' : 'сообщений нет', '']]} />}
            </button>
        );
    });

    const moduleHead = (id: string) => {
        const m = item?.modules.find(x => x.id === id);
        return { id, dot: off || !m ? '' : m.connected ? 'ok' : 'err', detail: (!off && m?.url) || m?.transport || '' };
    };

    const patch = (p: Partial<RulesSettings>) => setDraft(d => (d ? { ...d, ...p } : d));

    let left: React.ReactNode = null;
    if (draft && rules) {
        if (node === 'master') {
            left = <><StitchCard value={draft.stitch} onChange={stitch => patch({ stitch })} /><MasterEnvCard env={rules.env} /></>;
        } else if (node === 'websocket' && draft.websocket) {
            left = <WebSocketCard head={moduleHead('websocket')} value={draft.websocket} onChange={websocket => patch({ websocket })} catalog={catalog} onPick={() => setPick('websocket')} />;
        } else if (node === 'can' && draft.can) {
            left = <CanCard head={moduleHead('can')} value={draft.can} onChange={can => patch({ can })} catalog={catalog} onPick={() => setPick('can')} />;
        } else if (node === 'modbus' && draft.modbus) {
            left = <ModbusCard head={moduleHead('modbus')} value={draft.modbus} onChange={v => patch({ modbus: v })} />;
        } else {
            left = <div className="cr-none">Нет правил для модуля</div>;
        }
    }

    return (
        <section className="screen mod-screen cf-screen">
            <div className="mod">
                <div className="mod-body">
                    {!state.gateway ? (
                        <div className="empty">
                            <Icon name="gate" className="ico" />
                            <b>Шлюз АС КРСПС не отвечает</b>
                            {master && <p>Мастер работает по последней известной: {master.title}</p>}
                        </div>
                    ) : item ? (
                        <>
                            <div className="cr-body">
                                <div className="cf-head">
                                    <span className={`dot${item.active ? ' acc' : ''}`} />
                                    <h3>{item.title}</h3>
                                    <span className="id">{item.id}</span>
                                    <span className={`tag${item.active ? ' is-ok' : ''}`}>{item.active ? 'Активна' : 'Доступна'}</span>
                                    {!item.active && (
                                        <button className="btn btn--acc" disabled={busy} onClick={() => setPending(item)}>Сделать активной</button>
                                    )}
                                </div>
                                {!tableView && !dictView && (
                                    <div className="cr-chain">
                                        {devicesNode}
                                        <div className={`cr-wire${live && online.length ? ' is-live' : ''}`} />
                                        {masterNode}
                                        <div className={`cr-wire${live ? (gwUp ? ' is-live' : ' is-down') : ''}`} />
                                        {gatewayNode}
                                        <div className={`cr-wire${live && gwUp ? ' is-live' : ''}`} />
                                        <div className="cr-outs">{moduleNodes}</div>
                                    </div>
                                )}
                                {rulesError ? (
                                    <div className="empty">
                                        <Icon name="warn" className="ico" />
                                        <b>{rulesError}</b>
                                    </div>
                                ) : !draft ? (
                                    <div className="mod-loading"><span className="spin" /></div>
                                ) : (tableView || dictView) && (!draft.table || !draft.dictionaries) ? (
                                    <div className="empty">
                                        <Icon name="warn" className="ico" />
                                        <b>Мастер обнаружений не отдаёт таблицу соответствий и словари — обновите его</b>
                                    </div>
                                ) : dictView ? (
                                    <DictionariesPanel
                                        value={draft.dictionaries!}
                                        defaults={rules?.defaults.dictionaries}
                                        usage={tableUsage(draft.table!, models)}
                                        onChange={dictionaries => patch({ dictionaries })}
                                    />
                                ) : tableView ? (
                                    isIskraTable(draft.table) ? (
                                        <IskraTablePanel
                                            value={draft.table}
                                            onChange={table => patch({ table })}
                                            dicts={draft.dictionaries!}
                                            catalog={models}
                                            running={running}
                                            cameras={cameras}
                                        />
                                    ) : (
                                        <RsmTablePanel
                                            value={draft.table!}
                                            onChange={table => patch({ table })}
                                            dicts={draft.dictionaries!}
                                            catalog={models}
                                            running={running}
                                            cameras={cameras}
                                        />
                                    )
                                ) : (
                                    <div className="cr-split">
                                        <div className="cr-col">{left}</div>
                                        <div className="cr-col">
                                            <FeedTable
                                                node={node}
                                                entries={item.active ? link?.feed ?? [] : []}
                                                cameraName={cameraName}
                                                dicts={dictionariesOf(rules?.settings)}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                            {rules && draft && (
                                <div className="cr-foot">
                                    <span className="seps">
                                        {dirty > 0 && <span className="is-warn">изменено {dirty}</span>}
                                        {tableError && <span className="is-err">{tableError}</span>}
                                        <span>{savedLabel(rules.saved_at)}</span>
                                    </span>
                                    <span className="spacer" />
                                    <button className="btn" disabled={busy || !dirty} onClick={() => setDraft(clone(rules.settings))}>Сбросить</button>
                                    <button className="btn btn--acc" disabled={busy || !dirty || !!tableError} onClick={save}>Сохранить</button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="empty">
                            <Icon name="kit" className="ico" />
                            <b>Шлюз не отдал ни одной конфигурации</b>
                        </div>
                    )}
                </div>

                <aside className="mod-side">
                    <div className="blk-h"><h3>Конфигурации</h3><span className="eyebrow spacer">{items.length}</span></div>
                    <div className="cf-list">
                        {items.map(i => (
                            <button
                                key={i.id}
                                type="button"
                                className={`cf-pick${item?.id === i.id ? ' is-sel' : ''}`}
                                onClick={() => setSel(i.id)}
                            >
                                <div className="cf-pick-t">
                                    <b>{i.title}</b>
                                    <span className="id">{i.id}</span>
                                    <span className={`tag${i.active ? ' is-ok' : ''}`}>{i.active ? 'Активна' : 'Доступна'}</span>
                                </div>
                                <div className="cf-pick-m">
                                    {i.modules.map(m => <span key={m.id} className="tag">{m.title}</span>)}
                                </div>
                            </button>
                        ))}
                    </div>
                    {item && (
                        <>
                            <div className="blk-h"><h3>{item.title}</h3></div>
                            <div className="blk-b">
                                <button type="button" className={`mod-item${tableView || dictView ? '' : ' is-on'}`} onClick={() => navigate('/configurations')}>
                                    <Icon name="link" className="ico" /><span className="nm">Связь и правила</span>
                                </button>
                                <button type="button" className={`mod-item${tableView ? ' is-on' : ''}`} onClick={() => navigate('/configurations/table')}>
                                    <Icon name="tune" className="ico" /><span className="nm">Таблица соответствий</span>
                                </button>
                                <button type="button" className={`mod-item${dictView ? ' is-on' : ''}`} onClick={() => navigate('/configurations/dict')}>
                                    <Icon name="list" className="ico" /><span className="nm">Словари</span>
                                </button>
                            </div>
                        </>
                    )}
                </aside>
            </div>

            {pick && draft?.[pick] && (
                <ClassPicker
                    title={`Классы для ${MODULE_SHORT[pick]}`}
                    value={draft[pick]!.classes}
                    catalog={catalog}
                    onClose={() => setPick(null)}
                    onDone={classes => {
                        const cur = draft[pick]!;
                        patch({ [pick]: { ...cur, classes } } as Partial<RulesSettings>);
                        setPick(null);
                    }}
                />
            )}

            {pending && (
                <Modal
                    title={`Сделать активной: ${pending.title}`}
                    className="cf-confirm"
                    onClose={() => setPending(null)}
                    footer={
                        <>
                            <button className="btn btn--ghost spacer" onClick={() => setPending(null)}>Отмена</button>
                            <button className="btn btn--acc" disabled={busy} onClick={confirmSelect}>Сделать активной</button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <div className="kv"><span className="k">Сейчас</span><span className="v">{active?.title ?? '—'}</span></div>
                        <div className="kv">
                            <span className="k">Модули АС КРСПС</span>
                            <span className="v cf-arrow">
                                {active?.modules.map(m => <span key={m.id} className="tag">{m.title}</span>)}
                                <span className="to">→</span>
                                {pending.modules.map(m => <span key={m.id} className="tag is-acc">{m.title}</span>)}
                            </span>
                        </div>
                        <div className="kv">
                            <span className="k">Фильтр мастера</span>
                            <span className="v cf-arrow">
                                <span>{master?.title ?? '—'}</span>
                                <span className="to">→</span>
                                <span>{master?.available.find(r => r.id === pending.id)?.title ?? 'нет правил'}</span>
                            </span>
                        </div>
                        <div className="kv"><span className="k">Закроются обнаружения</span><span className="v">{master?.open ?? '—'}</span></div>
                    </div>
                </Modal>
            )}

            {toast && (
                <div className="toast">
                    <span className={`dot ${toast.tone}`} />
                    <div>{toast.text}</div>
                </div>
            )}
        </section>
    );
}
