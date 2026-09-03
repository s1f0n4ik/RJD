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
        setSaving(true);
        setError(null);
        try {
            await devicesApi.add({
                id: passport.id,
                ip: passport.ip,
                name: name.trim() || passportName(passport),
                modules: passport.modules,
            });
            onAdded(name.trim() || passportName(passport));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Не удалось добавить');
            setSaving(false);
        }
    };

    const canAdd = !!passport && !passport.known && !!name.trim() && !saving;

    return (
        <Modal
            title="Добавить устройство"
            size="mid"
            onClose={onClose}
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                    <button className="btn btn--acc" disabled={!canAdd} onClick={add}>Добавить</button>
                </>
            }
        >
            <div className="modal-b add-dev">
                <div className="add-line">
                    <input
                        className="inp"
                        placeholder="192.168.1.102"
                        value={ip}
                        autoFocus
                        onChange={e => setIp(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && ipValid && !probing) void probe(); }}
                    />
                    <button className="btn" disabled={!ipValid || probing} onClick={probe}>
                        {probing ? 'Опрос…' : 'Проверить'}
                    </button>
                    <button className="btn" disabled={scanning} onClick={scan}>
                        <Icon name="search" size={16} />{scanning ? 'Скан…' : 'Сканировать сеть'}
                    </button>
                </div>

                {error && (
                    <div className="banner is-err">
                        <Icon name="warn" size={15} />{error}
                    </div>
                )}

                {passport && (
                    <div className="add-card">
                        <div className="add-card-h">
                            <b>{passportName(passport)}</b>
                            <span className="mono">{passport.ip}</span>
                            {passport.known && <span className="tag is-warn spacer">уже в реестре</span>}
                        </div>
                        <div className="add-grid">
                            <span className="k">Идентификатор</span>
                            <span className="mono">{passport.id}</span>
                            <span className="k">Версия</span>
                            <span className="mono">{passport.version ?? '—'}</span>
                            <span className="k">Модули</span>
                            <span className="mods-line">
                                {passport.modules.length
                                    ? passport.modules.map(m => (
                                        <span key={m} className="tag is-acc">{MODULE_LABEL[m] ?? m}</span>
                                    ))
                                    : <span className="tag">только камеры</span>}
                            </span>
                        </div>
                        <div className="add-name">
                            <span className="fcap">Имя</span>
                            <input
                                className="inp"
                                value={name}
                                disabled={passport.known}
                                onChange={e => setName(e.target.value)}
                            />
                        </div>
                    </div>
                )}

                {found && (
                    <div className="add-found">
                        <div className="add-found-h">
                            <span className="eyebrow">Найдено в сети</span>
                            <span className="tag spacer">{found.length}</span>
                        </div>
                        {found.length === 0 && (
                            <div className="add-empty">
                                <Icon name="empty" size={28} />
                                <b>Устройства не найдены</b>
                            </div>
                        )}
                        {found.map(item => (
                            <button
                                key={item.id}
                                className={`add-row${passport?.id === item.id ? ' is-sel' : ''}`}
                                onClick={() => take(item)}
                            >
                                <span className="nm">{item.hostname || item.ip}</span>
                                <span className="mono">{item.ip}</span>
                                <span className="mods-line">
                                    {item.modules.map(m => (
                                        <span key={m} className="tag is-acc">{MODULE_LABEL[m] ?? m}</span>
                                    ))}
                                </span>
                                {item.known
                                    ? <span className="tag spacer">в реестре</span>
                                    : <span className="tag is-ok spacer">новое</span>}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </Modal>
    );
}
