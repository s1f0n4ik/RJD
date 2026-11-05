import { useEffect, useRef } from 'react';
import { Icon } from '../../app/Icons';
import { isModalOpen } from '../../app/Modal';
import type { RuntimeSnapshot } from './library-api';
import { ITEM_KINDS, problemTitle, reasonText } from './runtime-health';

const STATES = { running: 'Работает', starting: 'Запускается', failed: 'Не работает', unknown: 'Нет данных' };
const TONES = { running: 'ok', starting: 'warn', failed: 'err', unknown: '' };

// Шторка справа: что именно запущено на каждом устройстве профиля по снимку мастера
export function RuntimeDrawer({
    snapshot,
    nameOf,
    deviceName,
    onClose,
}: {
    snapshot: RuntimeSnapshot;
    nameOf: (kind: string, id: string) => string;
    deviceName: (place: string) => string;
    onClose: () => void;
}) {
    const closeButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        closeButton.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !isModalOpen()) onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    const total = snapshot.devices.reduce((sum, device) => sum + device.items.length, 0);
    const running = snapshot.devices.reduce((sum, device) => sum + device.items.filter((item) => item.state === 'running').length, 0);
    return (
        <>
            <div className="lb-scrim" onMouseDown={onClose} />
            <aside className="lb-drawer" role="dialog" aria-label="Состояние запуска">
                <div className="lb-drawer-h">
                    <h3>Состояние запуска</h3>
                    <span className="lb-n">
                        {running} / {total}
                    </span>
                    <button ref={closeButton} className="x" onClick={onClose} aria-label="Закрыть">
                        <Icon name="x" size={16} />
                    </button>
                </div>
                <div className="lb-drawer-b">
                    {snapshot.summary.state === 'transition' && <div className="lb-empty">Идёт загрузка профиля, модули остановлены</div>}
                    {!snapshot.devices.length && snapshot.summary.state !== 'transition' && (
                        <div className="lb-empty">У профиля нет привязанных устройств</div>
                    )}
                    {snapshot.devices.map((device) => {
                        const deviceProblems = snapshot.summary.problems.filter((item) => item.device === device.id && item.kind === 'device');
                        return (
                            <div key={device.id}>
                                <div className="lb-dg-h">
                                    {deviceName(device.place)}
                                    <span className="lb-n">{device.items.length}</span>
                                </div>
                                {deviceProblems.map((item) => (
                                    <div className="lb-rt is-warn" key={item.code}>
                                        <i className="dot warn" />
                                        <span className="d">
                                            <b>{ITEM_KINDS.device}</b>
                                            <span>{reasonText(item)}</span>
                                        </span>
                                    </div>
                                ))}
                                {device.items.map((item) => (
                                    <div className={`lb-rt is-${TONES[item.state]}`} key={`${item.kind}/${item.id}/${item.stream}`}>
                                        <i className={`dot ${TONES[item.state]}`} />
                                        <span className="d">
                                            <b>{problemTitle(item, nameOf)}</b>
                                            <span>{item.state === 'running' ? ITEM_KINDS[item.kind] : `${ITEM_KINDS[item.kind]} · ${reasonText(item)}`}</span>
                                        </span>
                                        <span className={`tag${TONES[item.state] ? ` is-${TONES[item.state]}` : ''}`}>{STATES[item.state]}</span>
                                    </div>
                                ))}
                                {!device.items.length && !deviceProblems.length && <div className="lb-empty">Нечего запускать</div>}
                            </div>
                        );
                    })}
                </div>
                <div className="lb-drawer-f">
                    <span className="sp">Снимок мастера от {new Date(snapshot.observed_at * 1000).toLocaleTimeString('ru-RU')}</span>
                    <button className="btn" onClick={onClose}>
                        Закрыть
                    </button>
                </div>
            </aside>
        </>
    );
}
