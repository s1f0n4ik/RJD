import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { configurationsApi, type CfItem, type CfMaster, type CfState } from './api';
import './configurations.css';

const POLL_MS = 3000;

interface ToastState {
    text: string;
    tone: 'ok' | 'err';
}

// Узел фильтра мастера: что он делает для выбранной конфигурации
function MasterNode({ item, master }: { item: CfItem; master: CfMaster | null }) {
    if (!master) {
        return (
            <div className="cf-node is-warn">
                <span className="eyebrow">Фильтр обнаружений</span>
                <b>мастер не отвечает</b>
            </div>
        );
    }
    if (item.active && master.active !== item.id) {
        return (
            <div className="cf-node is-warn">
                <span className="eyebrow">Фильтр обнаружений</span>
                <b>переключается</b>
                <span className="seps"><span>мастер видит {master.active ?? '—'}</span></span>
            </div>
        );
    }
    if (item.active && master.rules !== item.id) {
        return (
            <div className="cf-node is-warn">
                <span className="eyebrow">Фильтр обнаружений</span>
                <b>{master.title} вместо {item.id}</b>
                <span className="seps"><span>открыто {master.open}</span></span>
            </div>
        );
    }
    if (item.active) {
        return (
            <div className="cf-node">
                <span className="eyebrow">Фильтр обнаружений</span>
                <b>{master.title}</b>
                <p>{master.description}</p>
                <span className="seps"><span>открыто {master.open}</span><span>устройств {master.devices}</span></span>
            </div>
        );
    }
    const rule = master.available.find(r => r.id === item.id);
    if (rule) {
        return (
            <div className="cf-node">
                <span className="eyebrow">Фильтр обнаружений</span>
                <b>{rule.title}</b>
                <p>{rule.description}</p>
            </div>
        );
    }
    return (
        <div className="cf-node is-warn">
            <span className="eyebrow">Фильтр обнаружений</span>
            <b>нет правил</b>
            <span className="seps"><span>мастер работает по {master.available[0]?.title ?? master.title}</span></span>
        </div>
    );
}

function Flow({ item, master }: { item: CfItem; master: CfMaster | null }) {
    const live = item.active ? ' is-live' : '';
    return (
        <div className="cf-flow">
            <MasterNode item={item} master={master} />
            <div className={`cf-wire${live}`} />
            <div className="cf-node cf-gw">
                <span className="eyebrow">АС КРСПС</span>
                <b>Шлюз</b>
            </div>
            <div className={`cf-wire${live}`} />
            <div className="cf-outs">
                {item.modules.map(m => item.active ? (
                    <div key={m.id} className="cf-out" data-tip={m.connected ? undefined : m.error || undefined}>
                        <i className={`dot ${m.connected ? 'ok' : 'err'}`} />
                        <b>{m.title}</b>
                        <span>{m.url}</span>
                    </div>
                ) : (
                    <div key={m.id} className="cf-out is-off">
                        <i className="dot" />
                        <b>{m.title}</b>
                        <span>не активна</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function ConfigurationsScreen() {
    const [state, setState] = useState<CfState | null>(null);
    const [failed, setFailed] = useState(false);
    const [sel, setSel] = useState('');
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

    const { items, master } = state;
    const active = items.find(i => i.active) ?? null;
    const item = items.find(i => i.id === sel) ?? active ?? items[0] ?? null;

    return (
        <section className="screen mod-screen cf-screen">
            <div className="mod">
                <div className="mod-body cf-body">
                    {!state.gateway ? (
                        <div className="empty">
                            <Icon name="gate" className="ico" />
                            <b>Шлюз АС КРСПС не отвечает</b>
                            {master && <p>Мастер работает по последней известной: {master.title}</p>}
                        </div>
                    ) : item ? (
                        <>
                            <div className="cf-head">
                                <span className={`dot${item.active ? ' acc' : ''}`} />
                                <h3>{item.title}</h3>
                                <span className="id">{item.id}</span>
                                <span className={`tag${item.active ? ' is-ok' : ''}`}>{item.active ? 'Активна' : 'Доступна'}</span>
                                {!item.active && (
                                    <button className="btn btn--acc" disabled={busy} onClick={() => setPending(item)}>Сделать активной</button>
                                )}
                            </div>
                            <p className="cf-desc">{item.description}</p>
                            <div className="cf-sect">
                                <span className="eyebrow">Состав</span>
                                <Flow item={item} master={master} />
                            </div>
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
                </aside>
            </div>

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
