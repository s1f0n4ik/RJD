import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../app/Toast';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { krspsApi } from '../../features/krsps/api/client';
import type {
    GwCanConfigPatch,
    GwDevices,
    GwIntegrations,
    GwModbusConfigPatch,
    GwModbusModule,
    GwStatus,
    GwTime,
    GwWsConfigPatch,
} from '../../features/krsps/types';
import WebSocketModulePanel from '../../features/krsps/components/WebSocketModulePanel';
import CanModulePanel from '../../features/krsps/components/CanModulePanel';
import ModbusModulePanel from '../../features/krsps/components/ModbusModulePanel';
import TimeGpsPanel from '../../features/krsps/components/TimeGpsPanel';
import PanelBoundary from '../../features/krsps/components/PanelBoundary';
import { connState } from '../../features/krsps/components/ModuleBits';
import type { Dictionaries } from '../../features/krsps/utils/dictionaries';
import { configurationsApi, dictionariesOf } from '../configurations/api';
import { MODULE_LABEL, SERVICE_SECTIONS } from './sections';
import './krsps.css';

const STATUS_POLL_MS = 2000;
const TIME_POLL_MS = 5000;
const DEVICES_POLL_MS = 10_000;

const DOT_TONE: Record<string, string> = { ok: 'ok', wait: 'warn', err: 'err', off: '' };

export default function KrspsScreen() {
    const { section = '' } = useParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState<GwStatus | null>(null);
    const [failed, setFailed] = useState(false);
    const [integrations, setIntegrations] = useState<GwIntegrations | null>(null);
    const [devices, setDevices] = useState<GwDevices | null>(null);
    const [time, setTime] = useState<GwTime | null>(null);
    const [offsetMs, setOffsetMs] = useState(0);
    const [synced, setSynced] = useState(false);
    const [busy, setBusy] = useState(false);
    const [dicts, setDicts] = useState<Dictionaries>({});
    const toast = useToast();

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const showToast = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => toast(text, '', tone), [toast]);

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
        refreshDevices();
        const t = setInterval(refreshDevices, DEVICES_POLL_MS);
        return () => clearInterval(t);
    }, [refreshIntegrations, refreshDevices]);

    // Словари мастера для активной конфигурации: числа модулей расшифровываются по ним
    const ruleId = integrations?.active ?? status?.id ?? '';
    useEffect(() => {
        if (!ruleId) return;
        let stop = false;
        configurationsApi.getRules(ruleId)
            .then(r => { if (!stop) setDicts(dictionariesOf(r.settings)); })
            .catch(() => { if (!stop) setDicts({}); });
        return () => {
            stop = true;
        };
    }, [ruleId]);

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

    const handleSaveWs = (patch: GwWsConfigPatch) => run(() => krspsApi.updateWsConfig(patch), 'Настройки сохранены');
    const handleSaveCan = (patch: GwCanConfigPatch) => run(() => krspsApi.updateCanConfig(patch), 'Настройки сохранены');
    const handleSaveModbus = (patch: GwModbusConfigPatch) => run(() => krspsApi.updateModbusConfig(patch), 'Настройки сохранены');

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
    if (!SERVICE_SECTIONS.some(s => s.id === section) && !moduleIds.includes(section)) {
        return <Navigate to={`/krsps/${moduleIds[0] ?? SERVICE_SECTIONS[0].id}`} replace />;
    }
    const timeSource = time?.source.time;

    const selectedModule = status.modules.find(m => m.id === section) ?? null;
    const activeId = integrations?.active ?? status.id;
    const activeItem = integrations?.items.find(i => i.id === activeId);

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
                        ) : selectedModule?.transport === 'can' ? (
                            <CanModulePanel
                                module={selectedModule}
                                title={MODULE_LABEL[selectedModule.id] ?? selectedModule.title}
                                devices={devices}
                                dicts={dicts}
                                busy={busy}
                                onSave={handleSaveCan}
                                onConnect={handleConnect}
                                onDisconnect={handleDisconnect}
                            />
                        ) : selectedModule?.transport === 'modbus' ? (
                            <ModbusModulePanel
                                module={selectedModule as unknown as GwModbusModule}
                                title={MODULE_LABEL[selectedModule.id] ?? selectedModule.title}
                                devices={devices}
                                tzMin={time?.tz_offset_min ?? 180}
                                dicts={dicts}
                                busy={busy}
                                onSave={handleSaveModbus}
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
                    <div className="blk-h"><h3>Конфигурация</h3></div>
                    <div className="kr-now">
                        <span className="dot acc" />
                        <b>{activeItem?.title ?? activeId}</b>
                        <span className="id">{activeId}</span>
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
                                <Icon name={m.transport === 'websocket' ? 'swap' : 'bus'} />
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
                                        <span className="sub">{timeSource === 'can' ? 'шина CAN' : timeSource === 'modbus' ? 'Modbus' : 'системное'}</span>
                                        <span className={`dot ${timeSource === 'can' || timeSource === 'modbus' ? 'ok' : 'warn'}`} />
                                    </>
                                )}
                            </button>
                        ))}
                    </div>
                </aside>
            </div>
        </section>
    );
}
