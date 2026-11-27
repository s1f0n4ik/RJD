import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { getPeripheralSnapshot } from '../../features/kgf/api';
import type {
    PeripheralChannel,
    PeripheralDevice,
    PeripheralSnapshot,
    PeripheralValue,
} from '../../features/kgf/types';
import './kgf.css';

const POLL_MS = 1000;
const VALUE_STALE_MS = 5000;

const KIND_LABEL: Record<string, string> = {
    pyrometer_board: 'Плата пирометров',
    kelvin: 'Пирометр Kelvin',
    discrete: 'Дискретный модуль',
    lakibeam: 'LiDAR LakiBeam',
    descriptor: 'Внешний прибор',
};

const STATE_LABEL: Record<string, string> = {
    running: 'работает',
    starting: 'запускается',
    stopped: 'остановлен',
    unavailable: 'нет данных',
    error: 'ошибка',
};

const stateTone = (device: PeripheralDevice) => {
    if (device.message || device.state === 'error') return 'err';
    if (device.state === 'running') return 'ok';
    if (device.state === 'starting') return 'warn';
    return '';
};

const formatTime = (value: string | null | undefined) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('ru-RU');
};

const formatValue = (value: PeripheralValue | undefined, channel: PeripheralChannel) => {
    if (!value || value.value === null) return { main: '—', unit: channel.unit, bool: '' };
    if (typeof value.value === 'boolean') {
        return { main: value.value ? 'Да' : 'Нет', unit: '', bool: value.value ? 'true' : 'false' };
    }
    if (Array.isArray(value.value)) {
        return { main: value.value.join(' · '), unit: '', bool: '' };
    }
    if (typeof value.value === 'object') {
        const points = Array.isArray(value.value.points) ? value.value.points.length : null;
        if (points !== null) return { main: points.toLocaleString('ru-RU'), unit: 'точек', bool: '' };
        return { main: 'получено', unit: '', bool: '' };
    }
    if (typeof value.value === 'number') {
        const digits = Number.isInteger(value.value) ? 0 : 1;
        return {
            main: value.value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: 2 }),
            unit: channel.unit,
            bool: '',
        };
    }
    return { main: String(value.value), unit: channel.unit, bool: '' };
};

function ValueCard({ channel, value, now }: { channel: PeripheralChannel; value?: PeripheralValue; now: number }) {
    const shown = formatValue(value, channel);
    const age = value ? now - new Date(value.captured_at).getTime() : Number.POSITIVE_INFINITY;
    const stale = age > VALUE_STALE_MS;
    return (
        <div className={`kgf-value${stale ? ' is-stale' : ''}${shown.bool ? ` is-${shown.bool}` : ''}`}>
            <span className="kgf-value-name">{channel.name}</span>
            <div className="kgf-value-reading">
                <b>{shown.main}</b>
                {shown.unit && <span>{shown.unit}</span>}
            </div>
            <span className="kgf-value-meta">
                {value ? `${formatTime(value.captured_at)} · #${value.sequence}` : 'нет данных'}
            </span>
        </div>
    );
}

function DeviceCard({ device, values, now }: { device: PeripheralDevice; values: Map<string, PeripheralValue>; now: number }) {
    const tone = stateTone(device);
    return (
        <article className={`kgf-device${tone ? ` is-${tone}` : ''}`}>
            <header className="kgf-device-h">
                <span className={`dot ${tone}`} />
                <div className="kgf-device-title">
                    <b>{device.name}</b>
                    <span>{KIND_LABEL[device.kind] ?? device.kind} · <span className="num">{device.id}</span></span>
                </div>
                <span className={`tag${tone ? ` is-${tone}` : ''}`}>{STATE_LABEL[device.state] ?? device.state}</span>
            </header>
            {device.message && (
                <div className="kgf-device-error">
                    <Icon name="warn" size={15} />
                    <span>{device.message}</span>
                </div>
            )}
            <div className="kgf-values">
                {device.channels.map(channel => (
                    <ValueCard key={channel.id} channel={channel} value={values.get(channel.id)} now={now} />
                ))}
            </div>
        </article>
    );
}

export default function KgfScreen() {
    const [snapshot, setSnapshot] = useState<PeripheralSnapshot | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const [now, setNow] = useState(Date.now());
    const mounted = useRef(true);
    const request = useRef(0);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const refresh = useCallback(async () => {
        const id = ++request.current;
        setLoading(true);
        try {
            const next = await getPeripheralSnapshot();
            if (!mounted.current || id !== request.current) return;
            setSnapshot(next);
            setUpdatedAt(new Date());
            setFailed(false);
        } catch {
            if (mounted.current && id === request.current) setFailed(true);
        } finally {
            if (mounted.current && id === request.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), POLL_MS);
        return () => window.clearInterval(timer);
    }, []);

    const deviceValues = useMemo(() => {
        const result = new Map<string, Map<string, PeripheralValue>>();
        for (const value of snapshot?.values ?? []) {
            const values = result.get(value.device_id) ?? new Map<string, PeripheralValue>();
            values.set(value.channel_id, value);
            result.set(value.device_id, values);
        }
        return result;
    }, [snapshot]);

    const devices = snapshot?.status.devices ?? [];
    const errors = devices.filter(device => stateTone(device) === 'err').length;
    const liveValues = (snapshot?.values ?? []).filter(value => now - new Date(value.captured_at).getTime() <= VALUE_STALE_MS).length;
    const runtime = snapshot?.status.runtime;
    const runtimeOk = !failed && runtime?.state === 'running';

    return (
        <section className="screen kgf-screen glow">
            <div className="kgf-toolbar">
                <div>
                    <span className="eyebrow">Дополнительные модули РСМ 2000</span>
                    <h1>Периферия КГФ</h1>
                </div>
                <span className={`pill ${runtimeOk ? 'ok' : 'err'}`}>
                    <span className="dot" />
                    {failed ? 'нет связи' : runtime?.state === 'running' ? 'сервис работает' : runtime?.state ?? 'подключение'}
                </span>
                <span className="pill num">{updatedAt ? `обновлено ${updatedAt.toLocaleTimeString('ru-RU')}` : 'ожидание данных'}</span>
                <button className="btn btn--ghost btn--sm" onClick={() => void refresh()} disabled={loading}>
                    <Icon name="refresh" size={15} />
                    Обновить
                </button>
            </div>

            <div className="kgf-scroll">
                {failed && (
                    <div className="banner">
                        <Icon name="warn" size={16} />
                        Сервис периферии не отвечает. Показан последний полученный снимок.
                    </div>
                )}

                <div className="kgf-summary">
                    <div className="kgf-kpi">
                        <span>Приборов</span>
                        <b>{devices.length}</b>
                        <small>{devices.length ? `${devices.length - errors} без ошибок` : 'конфигурация пуста'}</small>
                    </div>
                    <div className={`kgf-kpi${errors ? ' is-err' : ' is-ok'}`}>
                        <span>Требуют внимания</span>
                        <b>{errors}</b>
                        <small>{errors ? 'ошибка связи или драйвера' : 'ошибок нет'}</small>
                    </div>
                    <div className="kgf-kpi is-acc">
                        <span>Актуальных каналов</span>
                        <b>{liveValues}</b>
                        <small>данные моложе 5 секунд</small>
                    </div>
                    <div className="kgf-kpi">
                        <span>Время и координаты</span>
                        <b>{snapshot?.status.gateway_time.can_time ? 'CAN' : snapshot?.status.gateway_time.ntp_time ? 'NTP' : '—'}</b>
                        <small>{snapshot?.status.gateway_time.gps_valid ? 'GPS подтверждён' : 'GPS нет'}</small>
                    </div>
                </div>

                {!snapshot && !failed ? (
                    <div className="kgf-empty"><span className="skel" /><span className="skel" /><span className="skel" /></div>
                ) : devices.length === 0 ? (
                    <div className="kgf-empty-state">
                        <Icon name="empty" size={32} />
                        <b>Приборы не настроены</b>
                        <span>Активируйте профиль КГФ или добавьте периферийные устройства в паспорт машины.</span>
                    </div>
                ) : (
                    <div className="kgf-devices">
                        {devices.map(device => (
                            <DeviceCard key={device.id} device={device} values={deviceValues.get(device.id) ?? new Map()} now={now} />
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
