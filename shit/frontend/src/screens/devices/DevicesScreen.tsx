import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { Select } from '../../app/Select';
import { elementAnchor, usePopover, type Anchor } from '../../app/popover';
import { useSystem } from '../../app/SystemContext';
import { AddDeviceModal } from './AddDeviceModal';
import { api } from '../../services/api';
import {
    devicesApi,
    getRouting,
    type Device,
    type RoutingTable,
} from '../../services/devices';
import {
    CAMERA_ROWS,
    MODULE_LABEL,
    MODULE_ROWS,
    deviceMetrics,
    isOnline,
    lastSeenTime,
    netLabel,
    routingCandidates,
    sameRouting,
    sinceLabel,
    sortDevices,
    uptimeLabel,
    type RoutingRow,
    type RoutingSlot,
} from './model';
import './devices.css';

const CAMERAS_POLL_MS = 15_000;

interface CameraCount {
    total: number;
    offline: boolean;
}

interface ToastState {
    text: string;
    tone: 'ok' | 'err';
}

export function DevicesScreen() {
    const { devices, refreshDevices } = useSystem();
    const navigate = useNavigate();

    const [routing, setRouting] = useState<RoutingTable>(getRouting());
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [counts, setCounts] = useState<Record<string, CameraCount>>({});
    const [addOpen, setAddOpen] = useState(false);
    const [menu, setMenu] = useState<{ device: Device; anchor: Anchor } | null>(null);
    const [renaming, setRenaming] = useState<Device | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [confirmDelete, setConfirmDelete] = useState<Device | null>(null);
    const [polling, setPolling] = useState<string | null>(null);
    const [toast, setToast] = useState<ToastState | null>(null);
    const toastTimer = useRef<number | null>(null);
    const menuRef = usePopover<HTMLDivElement>(menu?.anchor ?? null, { side: 'bottom', align: 'start' });

    const showToast = (text: string, tone: 'ok' | 'err' = 'ok') => {
        setToast({ text, tone });
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 4500);
    };

    // Маршруты приезжают тем же запросом, что список; правку пользователя не затираем
    useEffect(() => {
        if (!dirty) setRouting(getRouting());
    }, [devices, dirty]);

    useEffect(() => {
        let alive = true;

        const load = async () => {
            try {
                const cameras = await api.getCameras();
                if (!alive) return;
                const result: Record<string, CameraCount> = {};
                for (const camera of cameras) {
                    const id = camera.device_id ?? '';
                    if (!id) continue;
                    const entry = result[id] ?? { total: 0, offline: false };
                    entry.total += 1;
                    entry.offline = entry.offline || !!camera.offline;
                    result[id] = entry;
                }
                setCounts(result);
            } catch {
                if (alive) setCounts({});
            }
        };

        load();
        const timer = window.setInterval(load, CAMERAS_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, []);

    useEffect(() => {
        if (!menu) return;

        const onDown = (event: MouseEvent) => {
            if (menuRef.current?.contains(event.target as Node)) return;
            setMenu(null);
        };
        const close = () => setMenu(null);

        document.addEventListener('mousedown', onDown);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('mousedown', onDown);
            window.removeEventListener('resize', close);
        };
    }, [menu, menuRef]);

    const sorted = useMemo(() => sortDevices(devices), [devices]);
    const online = sorted.filter(isOnline).length;
    const cameraTotal = Object.values(counts).reduce((sum, c) => sum + c.total, 0);

    const setSlot = (slot: RoutingSlot, deviceId: string) => {
        setRouting(prev => ({ ...prev, [slot]: deviceId || null }));
        setDirty(true);
    };

    const saveRouting = async () => {
        setSaving(true);
        try {
            await devicesApi.saveRouting(routing);
            setDirty(false);
            setRouting(getRouting());
            showToast('Маршрутизация сохранена');
        } catch (e) {
            showToast(e instanceof Error ? e.message : 'Не удалось сохранить', 'err');
        } finally {
            setSaving(false);
        }
    };

    const resetRouting = () => {
        setRouting(getRouting());
        setDirty(false);
    };

    const pollDevice = async (device: Device) => {
        setPolling(device.id);
        try {
            const fresh = await devicesApi.poll(device.id);
            showToast(
                fresh.status === 'online'
                    ? `«${device.name}» ответило`
                    : `«${device.name}» не отвечает`,
                fresh.status === 'online' ? 'ok' : 'err',
            );
            await refreshDevices();
        } catch (e) {
            showToast(e instanceof Error ? e.message : 'Опрос не удался', 'err');
        } finally {
            setPolling(null);
        }
    };

    const applyRename = async () => {
        if (!renaming) return;
        const name = renameValue.trim();
        try {
            await devicesApi.rename(renaming.id, name);
            await refreshDevices();
            showToast(`Устройство переименовано в «${name}»`);
        } catch (e) {
            showToast(e instanceof Error ? e.message : 'Не удалось переименовать', 'err');
        } finally {
            setRenaming(null);
        }
    };

    const applyDelete = async () => {
        if (!confirmDelete) return;
        const device = confirmDelete;
        setConfirmDelete(null);
        try {
            await devicesApi.remove(device.id);
            await refreshDevices();
            showToast(`Устройство «${device.name}» удалено из реестра`);
        } catch (e) {
            showToast(e instanceof Error ? e.message : 'Не удалось удалить', 'err');
        }
    };

    const routingRow = (row: RoutingRow) => {
        const candidates = routingCandidates(devices, row);
        const value = routing[row.slot] ?? '';
        const missing = candidates.length === 0;

        return (
            <div className="route-row" key={row.slot}>
                <label>{row.label}</label>
                <Select
                    value={value}
                    disabled={missing}
                    placeholder="Не назначено"
                    options={[
                        { value: '', label: 'Не назначено' },
                        ...candidates.map(device => ({
                            value: device.id,
                            label: device.name,
                            hint: isOnline(device) ? device.ip : `${device.ip} · не в сети`,
                        })),
                    ]}
                    onChange={next => setSlot(row.slot, next)}
                />
                <span className={`tag${missing ? ' is-mute' : ''}`}>
                    {missing ? 'модуля нет' : row.state}
                </span>
            </div>
        );
    };

    return (
        <section className="screen dev-screen">
            <div className="filters">
                <span className="fld"><span className="k">Устройств</span><span className="v st-acc">{devices.length}</span></span>
                <span className="fld">
                    <span className="k">В сети</span>
                    <span className={`v ${online === devices.length ? 'st-ok' : 'st-warn'}`}>{online}</span>
                </span>
                <span className="fld"><span className="k">Камер</span><span className="v">{cameraTotal}</span></span>
                <span className="fld"><span className="k">Порт опроса</span><span className="v">7777</span></span>

                <span className="spacer" />
                <button className="btn btn--acc" onClick={() => setAddOpen(true)}>
                    <Icon name="plus" size={16} />Добавить устройство
                </button>
            </div>

            <div className="dev-body">
                {devices.length === 0 ? (
                    <div className="dev-empty">
                        <Icon name="dev" size={34} />
                        <b>Устройства не добавлены</b>
                        <button className="btn btn--acc" onClick={() => setAddOpen(true)}>
                            <Icon name="plus" size={16} />Добавить устройство
                        </button>
                    </div>
                ) : (
                    <div className="dev-grid">
                        {sorted.map(device => {
                            const offline = !isOnline(device);
                            const count = counts[device.id];
                            return (
                                <article key={device.id} className={`dev${offline ? ' is-off' : ''}`}>
                                    <div className="dev-h">
                                        <span className={`dot ${offline ? 'err' : 'ok'}`} />
                                        <div className="dev-name">
                                            <b>{device.name}</b>
                                            <div className="host">
                                                {device.ip} · {offline
                                                    ? `не в сети ${sinceLabel(device.last_seen)}`
                                                    : `в работе ${uptimeLabel(device.telemetry?.uptime_sec)}`}
                                            </div>
                                        </div>
                                        {offline && (
                                            <button
                                                className="btn btn--sm spacer"
                                                disabled={polling === device.id}
                                                onClick={() => pollDevice(device)}
                                            >
                                                <Icon name="refresh" size={15} />
                                                {polling === device.id ? 'Опрос…' : 'Повторить опрос'}
                                            </button>
                                        )}
                                        <button
                                            className={`icon-btn${offline ? '' : ' spacer'}`}
                                            aria-label="Действия"
                                            onClick={e => setMenu(
                                                menu?.device.id === device.id
                                                    ? null
                                                    : { device, anchor: elementAnchor(e.currentTarget) },
                                            )}
                                        >
                                            <Icon name="dots" size={17} />
                                        </button>
                                    </div>

                                    <div className="dev-b">
                                        {offline && (
                                            <div className="banner is-err">
                                                <Icon name="warn" size={15} />
                                                Последний ответ {lastSeenTime(device.last_seen)} · данные из кэша
                                            </div>
                                        )}

                                        {deviceMetrics(device).map(metric => (
                                            <div className="met" key={metric.key}>
                                                <span className="k">{metric.label}</span>
                                                <span className="bar sm">
                                                    <i
                                                        className={metric.tone === 'dim' ? '' : `is-${metric.tone}`}
                                                        style={{ width: `${metric.pct}%` }}
                                                    />
                                                </span>
                                                <span className="v">{metric.value}</span>
                                            </div>
                                        ))}

                                        <div className="kv">
                                            <span className="k">Сеть</span>
                                            <span className="v">{netLabel(device)}</span>
                                        </div>

                                        <div className="mods">
                                            <span className="tag">{device.telemetry?.version ?? 'версия неизвестна'}</span>
                                            {device.modules.map(module => {
                                                const assigned = routing[module as RoutingSlot] === device.id;
                                                return (
                                                    <span
                                                        key={module}
                                                        className={`tag is-acc${assigned ? '' : ' is-mute'}`}
                                                    >
                                                        {MODULE_LABEL[module] ?? module}
                                                    </span>
                                                );
                                            })}
                                            {routing.cameras === device.id && (
                                                <span className="tag is-acc">новые камеры</span>
                                            )}
                                            <button
                                                className={`tag tag-btn ${count?.offline ? 'is-err' : 'is-ok'}`}
                                                onClick={() => navigate(`/cameras?device=${encodeURIComponent(device.id)}`)}
                                            >
                                                камер: {count?.total ?? 0}{count?.offline ? ' · офлайн' : ''}
                                            </button>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="blk dev-routing">
                <div className="blk-h"><h3>Маршрутизация</h3></div>
                <div className="blk-b">
                    <div className="route-grid">
                        <div className="route-col">
                            <span className="eyebrow">Модули</span>
                            {MODULE_ROWS.map(routingRow)}
                        </div>
                        <div className="route-col">
                            <span className="eyebrow">Камеры</span>
                            {CAMERA_ROWS.map(routingRow)}
                        </div>
                    </div>
                </div>
                <div className="blk-f">
                    {dirty && <span className="tag is-warn">есть несохранённые правки</span>}
                    <button className="btn btn--ghost spacer" disabled={!dirty} onClick={resetRouting}>
                        Сбросить
                    </button>
                    <button
                        className="btn btn--acc"
                        disabled={!dirty || saving || sameRouting(routing, getRouting())}
                        onClick={saveRouting}
                    >
                        Сохранить
                    </button>
                </div>
            </div>

            {menu && (
                <div className="dev-menu" ref={menuRef}>
                    <button
                        onClick={() => {
                            setRenaming(menu.device);
                            setRenameValue(menu.device.name);
                            setMenu(null);
                        }}
                    >
                        Переименовать
                    </button>
                    {isOnline(menu.device) && (
                        <button
                            onClick={() => {
                                void pollDevice(menu.device);
                                setMenu(null);
                            }}
                        >
                            Повторить опрос
                        </button>
                    )}
                    <button
                        className="is-err"
                        onClick={() => {
                            setConfirmDelete(menu.device);
                            setMenu(null);
                        }}
                    >
                        Удалить
                    </button>
                </div>
            )}

            {addOpen && (
                <AddDeviceModal
                    onClose={() => setAddOpen(false)}
                    onAdded={async name => {
                        setAddOpen(false);
                        await refreshDevices();
                        showToast(`Устройство «${name}» добавлено`);
                    }}
                />
            )}

            {renaming && (
                <Modal
                    title={`Переименовать «${renaming.name}»`}
                    onClose={() => setRenaming(null)}
                    footer={
                        <>
                            <button className="btn btn--ghost spacer" onClick={() => setRenaming(null)}>Отмена</button>
                            <button
                                className="btn btn--acc"
                                disabled={!renameValue.trim() || renameValue.trim() === renaming.name}
                                onClick={applyRename}
                            >
                                Применить
                            </button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <div className="fcell">
                            <span className="fcap">Имя</span>
                            <input
                                className="inp"
                                value={renameValue}
                                autoFocus
                                onChange={e => setRenameValue(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') void applyRename(); }}
                            />
                        </div>
                    </div>
                </Modal>
            )}

            {confirmDelete && (
                <Modal
                    title={`Удалить устройство «${confirmDelete.name}»?`}
                    onClose={() => setConfirmDelete(null)}
                    footer={
                        <>
                            <button className="btn btn--ghost spacer" onClick={() => setConfirmDelete(null)}>Отмена</button>
                            <button className="btn btn--err" onClick={applyDelete}>Удалить</button>
                        </>
                    }
                >
                    <div className="modal-b del-dev">
                        <div className="route-row">
                            <label>Адрес</label>
                            <span className="mono">{confirmDelete.ip}</span>
                        </div>
                        <div className="route-row">
                            <label>Камер</label>
                            <span className="mono">{counts[confirmDelete.id]?.total ?? 0}</span>
                        </div>
                        <div className="route-row">
                            <label>Назначенные модули</label>
                            <span className="mods-line">
                                {(Object.keys(routing) as RoutingSlot[])
                                    .filter(slot => routing[slot] === confirmDelete.id)
                                    .map(slot => (
                                        <span key={slot} className="tag is-acc">
                                            {slot === 'cameras' ? 'новые камеры' : MODULE_LABEL[slot] ?? slot}
                                        </span>
                                    ))}
                            </span>
                        </div>
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
