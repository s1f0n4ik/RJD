import { useState } from 'react';
import { Modal } from '../../app/Modal';
import { Icon } from '../../app/Icons';
import { devicesApi, type DevicePassport, type ScanResult } from '../../services/devices';
import { MODULE_LABEL } from './model';

interface AddDeviceModalProps {
    onClose: () => void;
    onAdded: (name: string) => void;
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

const passportName = (passport: DevicePassport): string =>
    passport.hostname?.trim() || passport.ip;

const modulesLine = (modules: string[]): string =>
    modules.length ? modules.map(m => MODULE_LABEL[m] ?? m).join(' · ') : 'только камеры';

export function AddDeviceModal({ onClose, onAdded }: AddDeviceModalProps) {
    const [ip, setIp] = useState('');
    const [passport, setPassport] = useState<DevicePassport | null>(null);
    const [name, setName] = useState('');
    const [probing, setProbing] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [found, setFound] = useState<ScanResult[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const ipValid = IP_RE.test(ip.trim());
    const busy = probing || scanning || saving;

    const take = (device: DevicePassport) => {
        setPassport(device);
        setIp(device.ip);
        setName(passportName(device));
        setError(null);
    };

    const probe = async () => {
        setProbing(true);
        setError(null);
        setPassport(null);
        try {
            const { device } = await devicesApi.probe(ip.trim());
            take(device);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Устройство не ответило');
        } finally {
            setProbing(false);
        }
    };

    const scan = async () => {
        setScanning(true);
        setError(null);
        try {
            const { found: result } = await devicesApi.scan();
            setFound(result);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Скан не удался');
        } finally {
            setScanning(false);
        }
    };

    const add = async () => {
        if (!passport) return;
        const finalName = name.trim() || passportName(passport);
        setSaving(true);
        setError(null);
        try {
            await devicesApi.add({
                id: passport.id,
                ip: passport.ip,
                name: finalName,
                modules: passport.modules,
            });
            onAdded(finalName);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Не удалось добавить');
            setSaving(false);
        }
    };

    const canAdd = !!passport && !passport.known && !!name.trim() && !busy;

    return (
        <Modal
            title="Добавить устройство"
            className="add-dev-modal"
            onClose={onClose}
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                    <button className="btn btn--acc" disabled={!canAdd} onClick={add}>Добавить</button>
                </>
            }
        >
            <div className="modal-b add-dev">
                <div className="addr">
                    <span className="fcap">Адрес устройства</span>
                    <div className="addr-in">
                        <input
                            className="inp mono"
                            placeholder="192.168.1.102"
                            value={ip}
                            autoFocus
                            disabled={probing}
                            onChange={e => setIp(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && ipValid && !busy) void probe(); }}
                        />
                        <button className="btn" disabled={!ipValid || busy} onClick={probe}>
                            {probing ? 'Опрос…' : 'Проверить'}
                        </button>
                    </div>
                    {probing && <div className="probe-bar"><i /></div>}
                </div>

                {error && (
                    <div className="banner is-err">
                        <Icon name="warn" size={15} />{error}
                    </div>
                )}

                {probing && (
                    <div className="pass is-skel">
                        <div className="pass-h">
                            <span className="skel" style={{ width: 120 }} />
                            <span className="skel spacer" style={{ width: 88 }} />
                        </div>
                        <div className="pass-g">
                            <span className="k">Идентификатор</span><span className="v"><span className="skel" /></span>
                            <span className="k">Версия</span><span className="v"><span className="skel" style={{ width: '40%' }} /></span>
                            <span className="k">Модули</span><span className="v"><span className="skel" style={{ width: '55%' }} /></span>
                        </div>
                    </div>
                )}

                {passport && !probing && (
                    <div className="pass">
                        <div className="pass-h">
                            <span className="dot ok" />
                            <b>{passportName(passport)}</b>
                            {passport.known
                                ? <span className="tag is-warn spacer">уже в реестре</span>
                                : <span className="mono spacer">{passport.version ?? '—'}</span>}
                        </div>
                        <div className="pass-g">
                            <span className="k">Идентификатор</span>
                            <span className="v">{passport.id}</span>
                            <span className="k">Модули</span>
                            <span className="mods-line">
                                {passport.modules.length
                                    ? passport.modules.map(m => (
                                        <span key={m} className="tag is-acc">{MODULE_LABEL[m] ?? m}</span>
                                    ))
                                    : <span className="tag">только камеры</span>}
                            </span>
                        </div>
                        {!passport.known && (
                            <div className="pass-name">
                                <div className="fcell">
                                    <span className="fcap">Имя</span>
                                    <input
                                        className="inp"
                                        value={name}
                                        onChange={e => setName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && canAdd) void add(); }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {found === null ? (
                    <>
                        <div className="divider">или</div>
                        <button className="btn btn--wide" disabled={busy} onClick={scan}>
                            <Icon name="search" size={15} />
                            {scanning ? 'Скан…' : 'Найти в сети · порт 7777'}
                        </button>
                        {scanning && <div className="probe-bar"><i /></div>}
                    </>
                ) : (
                    <div className="found">
                        <div className="found-h">
                            <span className="eyebrow">Найдено в сети</span>
                            <span className="tag">{found.length}</span>
                            <button className="btn btn--sm spacer" disabled={busy} onClick={scan}>
                                {scanning ? 'Скан…' : 'Повторить'}
                            </button>
                        </div>
                        {scanning && <div className="probe-bar"><i /></div>}
                        {found.length === 0 && !scanning && (
                            <div className="fnd-empty">
                                <Icon name="empty" size={28} />
                                <b>Устройства не найдены</b>
                            </div>
                        )}
                        {found.map(item => {
                            const selected = passport?.id === item.id;
                            return (
                                <button
                                    key={item.id}
                                    className={`fnd-row${selected ? ' is-sel' : ''}${item.known ? ' is-known' : ''}`}
                                    disabled={item.known || busy}
                                    onClick={() => take(item)}
                                >
                                    <span className="fnd-main">
                                        <span className="nm">
                                            {item.hostname || item.ip}
                                            {item.known && <span className="tag tag--xs">в реестре</span>}
                                        </span>
                                        <span className="sub">{item.ip} · {modulesLine(item.modules)}</span>
                                    </span>
                                    <span className="fnd-right">
                                        <span className="tag">{item.version ?? '—'}</span>
                                        {!item.known && <span className="tag is-ok">новое</span>}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </Modal>
    );
}
