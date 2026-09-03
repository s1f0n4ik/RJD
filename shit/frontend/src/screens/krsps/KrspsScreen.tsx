import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { krspsApi } from '../../features/krsps/api/client';
import type {
    GwCanConfigPatch,
    GwDevices,
    GwIntegrationItem,
    GwIntegrations,
    GwStatus,
    GwTaxonomy,
    GwTaxonomyPatch,
    GwTime,
    GwWsConfigPatch,
} from '../../features/krsps/types';
import WebSocketModulePanel from '../../features/krsps/components/WebSocketModulePanel';
import CanModulePanel from '../../features/krsps/components/CanModulePanel';
import TaxonomyPanel from '../../features/krsps/components/TaxonomyPanel';
import TimeGpsPanel from '../../features/krsps/components/TimeGpsPanel';
import PanelBoundary from '../../features/krsps/components/PanelBoundary';
import { connState } from '../../features/krsps/components/ModuleBits';
import { MODULE_LABEL, SERVICE_SECTIONS, isServiceSection } from './sections';
import './krsps.css';

const STATUS_POLL_MS = 2000;
const TIME_POLL_MS = 5000;
const DEVICES_POLL_MS = 10_000;

interface ToastState {
    text: string;
    tone: 'ok' | 'err';
}

const DOT_TONE: Record<string, string> = { ok: 'ok', wait: 'warn', err: 'err', off: '' };

export default function KrspsScreen() {
    const { section = '' } = useParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState<GwStatus | null>(null);
    const [failed, setFailed] = useState(false);
    const [integrations, setIntegrations] = useState<GwIntegrations | null>(null);
    const [taxonomy, setTaxonomy] = useState<GwTaxonomy | null>(null);
    const [devices, setDevices] = useState<GwDevices | null>(null);
    const [time, setTime] = useState<GwTime | null>(null);
    const [offsetMs, setOffsetMs] = useState(0);
    const [synced, setSynced] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<GwIntegrationItem | null>(null);
    const [toast, setToast] = useState<ToastState | null>(null);
    const toastTimer = useRef<number | null>(null);

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const showToast = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
        setToast({ text, tone });
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 4500);
    }, []);

    const refreshIntegrations = useCallback(async () => {
        try {
            const ints = await krspsApi.getIntegrations();
            if (alive.current) setIntegrations(ints);
        } catch {
            /* заглушка раздела покажет молчание шлюза */
        }
    }, []);

    // Статус раз в 2 с; молчание шлюза переводит раздел в заглушку, ответ возвращает
    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const s = await krspsApi.getStatus();
                if (!stop && alive.current) {
                    setStatus(s);
                    setFailed(false);
                }
            } catch {
                if (!stop && alive.current) {
                    setStatus(null);
                    setFailed(true);
                }
            }
        };
        tick();
        const t = setInterval(tick, STATUS_POLL_MS);
        return () => {
            stop = true;
            clearInterval(t);
        };
    }, []);

    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const t = await krspsApi.getTime();
                if (!stop && alive.current) {
                    setTime(t);
                    setOffsetMs(t.unix_ms - Date.now());
                    setSynced(true);
                }
            } catch {
                /* таймер продолжит идти локально */
            }
        };
        tick();
        const t = setInterval(tick, TIME_POLL_MS);
        return () => {
            stop = true;
            clearInterval(t);
        };
    }, []);

    const refreshTaxonomy = useCallback(async () => {
        try {
            const t = await krspsApi.getTaxonomy();
            if (alive.current) setTaxonomy(t);
        } catch {
            /* раздел покажет загрузку */
        }
    }, []);

    // Устройства перечитываем регулярно: адаптер могли воткнуть после запуска
    const refreshDevices = useCallback(async () => {
        try {
            const d = await krspsApi.getDevices();
            if (alive.current) setDevices(d);
        } catch {
            /* имя устройства всегда можно ввести руками */
        }
    }, []);

    useEffect(() => {
        refreshIntegrations();
        refreshTaxonomy();
        refreshDevices();
        const t = setInterval(refreshDevices, DEVICES_POLL_MS);
        return () => clearInterval(t);
    }, [refreshIntegrations, refreshTaxonomy, refreshDevices]);

    const run = useCallback(
        async (fn: () => Promise<unknown>, okMsg: string) => {
            setBusy(true);
            try {
                await fn();
                const s = await krspsApi.getStatus().catch(() => null);
                if (alive.current && s) setStatus(s);
                await refreshIntegrations();
                if (alive.current) showToast(okMsg);
            } catch (e) {
                if (alive.current) showToast(e instanceof Error ? e.message : 'Ошибка запроса', 'err');
            } finally {
                if (alive.current) setBusy(false);
            }
        },
        [refreshIntegrations, showToast],
    );

    const confirmSelect = () => {
        if (!pending) return;
        const id = pending.id;
        setPending(null);
        run(() => krspsApi.selectIntegration(id), 'Конфигурация переключена');
    };
    const handleSaveWs = (patch: GwWsConfigPatch) => run(() => krspsApi.updateWsConfig(patch), 'Настройки сохранены');
    const handleSaveCan = (patch: GwCanConfigPatch) => run(() => krspsApi.updateCanConfig(patch), 'Настройки сохранены');
    const handleSaveTaxonomy = (patch: GwTaxonomyPatch) =>
        run(async () => {
            const t = await krspsApi.updateTaxonomy(patch);
            if (alive.current) setTaxonomy(t);
        }, 'Таблица сохранена');

    // Подключение адресное: трогаем только модуль, открытый на странице
    const handleConnect = () => run(() => krspsApi.connectModule(section), 'Переподключение запущено');
    const handleDisconnect = () => run(() => krspsApi.disconnectModule(section), 'Соединение закрыто');

    if (!status) {
        if (!failed) {
            return (
                <section className="screen mod-screen">
                    <div className="mod-loading"><span className="spin" /></div>
                </section>
            );
        }
        return (
            <section className="screen mod-screen">
                <div className="notice">
                    <Icon name="warn" className="ico" />
                    <h2>АС КРСПС недоступна</h2>
                    <p>Сервис шлюза не отвечает</p>
                    <button className="btn" onClick={() => navigate('/')}>На главную</button>
                </div>
            </section>
        );
    }

    const moduleIds = status.modules.map(m => m.id);
    if (!isServiceSection(section) && !moduleIds.includes(section)) {
        return <Navigate to={`/krsps/${moduleIds[0] ?? SERVICE_SECTIONS[0].id}`} replace />;
    }

    const selectedModule = status.modules.find(m => m.id === section) ?? null;
    const items = integrations?.items ?? [];
    const active = integrations?.active ?? status.id;

    return (
        <section className="screen mod-screen">
            <div className="mod">
                <div className="mod-body">
                    <PanelBoundary resetKey={section}>
                        {section === 'time' ? (
                            <TimeGpsPanel
                                time={time}
                                offsetMs={offsetMs}
                                synced={synced}
                                onTimeUpdate={t => {
                                    setTime(t);
                                    setOffsetMs(t.unix_ms - Date.now());
                                    setSynced(true);
                                }}
                            />
                        ) : section === 'taxonomy' ? (
                            <TaxonomyPanel taxonomy={taxonomy} busy={busy} onSave={handleSaveTaxonomy} />
                        ) : selectedModule?.transport === 'can' ? (
                            <CanModulePanel
                                module={selectedModule}
                                title={MODULE_LABEL[selectedModule.id] ?? selectedModule.title}
                                devices={devices}
                                busy={busy}
                                onSave={handleSaveCan}
                                onConnect={handleConnect}
                                onDisconnect={handleDisconnect}
                            />
                        ) : selectedModule ? (
                            <WebSocketModulePanel
                                module={selectedModule}
                                title={MODULE_LABEL[selectedModule.id] ?? selectedModule.title}
                                busy={busy}
                                onSave={handleSaveWs}
                                onConnect={handleConnect}
                                onDisconnect={handleDisconnect}
                            />
                        ) : null}
                    </PanelBoundary>
                </div>

                <aside className="mod-side">
                    <div className="blk-h">
                        <h3>Конфигурация</h3>
                        <span className="eyebrow spacer">{items.length ? `${items.findIndex(i => i.id === active) + 1} из ${items.length}` : '—'}</span>
                    </div>
                    <div className="cfg-list">
                        {items.map(item => {
                            const isActive = item.id === active;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    className={`cfg${isActive ? ' is-active' : ''}`}
                                    disabled={busy}
                                    onClick={() => !isActive && setPending(item)}
                                >
                                    <div className="cfg-t">
                                        <b>{item.title}</b>
                                        <span className="id">{item.id}</span>
                                        <span className={`tag${isActive ? ' is-ok' : ''}`}>{isActive ? 'Активна' : 'Доступна'}</span>
                                    </div>
                                    <div className="cfg-m">
                                        {item.modules.length ? item.modules.map(m => (
                                            <span key={m.id} className="tag">{m.title}</span>
                                        )) : <span className="tag">без модулей</span>}
                                    </div>
                                </button>
                            );
                        })}
                        {items.length === 0 && <div className="cfg-empty">Нет доступных конфигураций</div>}
                    </div>

                    <div className="blk-h"><h3>Модули конфигурации</h3></div>
                    <div className="blk-b">
                        {status.modules.map(m => (
                            <button
                                key={m.id}
                                type="button"
                                className={`mod-item${section === m.id ? ' is-on' : ''}`}
                                onClick={() => navigate(`/krsps/${m.id}`)}
                            >
                                <Icon name={m.transport === 'can' ? 'bus' : 'swap'} />
                                <span className="nm">{MODULE_LABEL[m.id] ?? m.title}</span>
                                <span className="sub">{m.transport}</span>
                                <span className={`dot ${DOT_TONE[connState(m)]}`} />
                            </button>
                        ))}
                        {status.modules.length === 0 && <div className="cfg-empty">В конфигурации нет модулей</div>}
                    </div>

                    <div className="blk-h"><h3>Сервис</h3></div>
                    <div className="blk-b">
                        {SERVICE_SECTIONS.map(s => (
                            <button
                                key={s.id}
                                type="button"
                                className={`mod-item${section === s.id ? ' is-on' : ''}`}
                                onClick={() => navigate(`/krsps/${s.id}`)}
                            >
                                <Icon name={s.icon} />
                                <span className="nm">{s.label}</span>
                                {s.id === 'time' && time && (
                                    <>
                                        <span className="sub">{time.source.time === 'can' ? 'шина CAN' : 'системное'}</span>
                                        <span className={`dot ${time.source.time === 'can' ? 'ok' : 'warn'}`} />
                                    </>
                                )}
                            </button>
                        ))}
                    </div>
                </aside>
            </div>

            {pending && (
                <Modal
                    title="Сделать активной конфигурацию?"
                    className="krsps-confirm"
                    onClose={() => setPending(null)}
                    footer={
                        <>
                            <button className="btn btn--ghost spacer" onClick={() => setPending(null)}>Отмена</button>
                            <button className="btn btn--acc" disabled={busy} onClick={confirmSelect}>Сделать активной</button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <div className="kv"><span className="k">Конфигурация</span><span className="v">{pending.title}</span></div>
                        <div className="kv"><span className="k">id</span><span className="v">{pending.id}</span></div>
                        <div className="kv">
                            <span className="k">Модули</span>
                            <span className="v" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                {pending.modules.map(m => <span key={m.id} className="tag">{m.title}</span>)}
                            </span>
                        </div>
                        <div className="kv"><span className="k">Сейчас активна</span><span className="v">{items.find(i => i.id === active)?.title ?? '—'}</span></div>
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
