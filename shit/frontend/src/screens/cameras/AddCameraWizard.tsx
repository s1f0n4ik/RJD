import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal, Switch } from '../../app/Modal';
import { Select } from '../../app/Select';
import { api } from '../../services/api';
import { deviceForCameraType, getDevices, mcPath, signalingWsUrl } from '../../services/devices';
import { useTypeAvailability } from './CameraFields';
import { LivePreview } from './LivePreview';
import { ScanModal } from './ScanModal';
import {
    DEFAULT_FORM,
    PRODUCTION_NAMES,
    TYPE_NAMES,
    VENDOR_TO_PRODUCTION,
    findNextFreeCameraId,
    formToPayload,
    formatError,
    validateCameraName,
    validateIp,
    validatePort,
    type Camera,
    type CameraFormData,
} from './model';

type ProbeStatus = 'idle' | 'creating' | 'streaming' | 'error';

interface AddCameraWizardProps {
    cameras: Camera[];
    initial?: Partial<CameraFormData>;
    onClose: () => void;
    onSaved: (message: string) => void;
}

/** Поле с подписью сверху — локальный близнец Cell из CameraFields. */
function F({ cap, children }: { cap: string; children: React.ReactNode }) {
    return (
        <label className="fcell">
            <span className="fcap">{cap}</span>
            {children}
        </label>
    );
}

export function AddCameraWizard({ cameras, initial, onClose, onSaved }: AddCameraWizardProps) {
    const [form, setForm] = useState<CameraFormData>({ ...DEFAULT_FORM, ...initial });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [scanOpen, setScanOpen] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    const [probeStatus, setProbeStatus] = useState<ProbeStatus>('idle');
    const [probeError, setProbeError] = useState('');
    const [probeName, setProbeName] = useState<string | null>(null);
    const probeNameRef = useRef<string | null>(null);
    const probeDeviceRef = useRef<string | null>(null);

    const onChange = (patch: Partial<CameraFormData>) => setForm(prev => ({ ...prev, ...patch }));

    const types = useTypeAvailability();
    const autoName = useMemo(() => findNextFreeCameraId(cameras), [cameras]);
    const existingNames = useMemo(() => cameras.map(c => c.id), [cameras]);
    const nameCheck = useMemo(() => validateCameraName(form.id, existingNames, false), [form.id, existingNames]);
    const ipCheck = useMemo(() => validateIp(form.ip_adress), [form.ip_adress]);
    const portCheck = useMemo(() => validatePort(form.port), [form.port]);
    const isValid = nameCheck.valid && ipCheck.valid && portCheck.valid;

    const targetDevice = useMemo(() => {
        try {
            const id = deviceForCameraType(Number(form.type));
            return getDevices().find(d => d.id === id)?.name ?? null;
        } catch {
            return null;
        }
    }, [form.type]);

    // === PROBE: временная камера ради живой проверки в левой панели ===
    const cleanupProbe = useCallback(async () => {
        const name = probeNameRef.current;
        const device = probeDeviceRef.current;
        if (!name) return;
        probeNameRef.current = null;
        probeDeviceRef.current = null;
        setProbeName(null);
        try {
            await api.deleteCamera(name, device ?? deviceForCameraType(1));
        } catch {
            /* тихо: probe и так временный */
        }
    }, []);

    const startProbe = useCallback(async (current: CameraFormData) => {
        await cleanupProbe();
        setProbeError('');
        setProbeStatus('creating');

        const tempName = `__probe_${Date.now()}`;
        const payload = formToPayload({ ...current, to_record: false, main_segment: 0 }, tempName);
        payload.display_name = `Probe ${current.ip_adress}`;
        payload.description = 'Temporary probe';

        try {
            await api.createCamera(payload);
            probeNameRef.current = tempName;
            probeDeviceRef.current = deviceForCameraType(Number(current.type ?? 1));
            setProbeName(tempName);
            window.setTimeout(() => setProbeStatus(s => (s === 'creating' ? 'streaming' : s)), 1500);
        } catch (err) {
            setProbeError(formatError(err));
            setProbeStatus('error');
        }
    }, [cleanupProbe]);

    // Проверка стартует сама: подключение валидно и не менялось 900 мс.
    // Дебаунс обязателен — каждый пуск создаёт настоящую камеру на устройстве.
    const probeKey = [form.ip_adress, form.port, form.user, form.password, form.production, form.type].join('|');
    useEffect(() => {
        if (!ipCheck.valid || !portCheck.valid) return;
        const timer = window.setTimeout(() => void startProbe(form), 900);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [probeKey, ipCheck.valid, portCheck.valid]);

    // Уборка probe при закрытии вкладки: keepalive переживает unload
    useEffect(() => {
        const handler = () => {
            if (probeNameRef.current && probeDeviceRef.current) {
                fetch(mcPath(probeDeviceRef.current, `/camera?id=${encodeURIComponent(probeNameRef.current)}`), {
                    method: 'DELETE',
                    keepalive: true,
                }).catch(() => {});
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    useEffect(() => () => { void cleanupProbe(); }, [cleanupProbe]);

    const close = async () => {
        await cleanupProbe();
        onClose();
    };

    const save = async () => {
        if (!isValid) return;
        setSaving(true);
        setError('');
        const cameraId = form.id || autoName;
        try {
            await cleanupProbe();
            await api.createCamera(formToPayload(form, cameraId));
            onSaved(`Камера ${cameraId} добавлена`);
        } catch (err) {
            setError(formatError(err));
        } finally {
            setSaving(false);
        }
    };

    // Скан из мастера: «Выбрать» заносит адрес и вендора в форму
    const pickFromScan = (found: { ip: string; vendor: string | null }) => {
        const production = found.vendor ? VENDOR_TO_PRODUCTION[found.vendor] : undefined;
        onChange({ ip_adress: found.ip, ...(production ? { production } : {}) });
        setScanOpen(false);
    };

    const previewStyle = { flex: '0 0 178px', alignSelf: 'stretch', aspectRatio: 'auto', width: 'auto' } as const;

    return (
        <>
            <Modal
                title="Добавить камеру"
                className="add-modal"
                onClose={() => { void close(); }}
                head={targetDevice
                    ? <span className="num muted" style={{ fontSize: 11 }}>будет создана на {targetDevice}</span>
                    : undefined}
            >
                <div className="add-body">
                    <aside className="add-side">
                        <span className="eyebrow">Живая проверка</span>

                        {probeStatus === 'error' ? (
                            <div className="cam-preview" style={previewStyle}>
                                <div className="state">{probeError || 'Поток не открылся'}</div>
                            </div>
                        ) : probeName && probeDeviceRef.current ? (
                            <LivePreview
                                key={probeName}
                                cameraId={probeName}
                                signalingUrl={signalingWsUrl(probeDeviceRef.current, `/client/${probeName}`)}
                                caption={`канал ${form.main_sub}`}
                                style={previewStyle}
                            />
                        ) : (
                            <div className="cam-preview" style={previewStyle}>
                                <div className="state">
                                    {probeStatus === 'creating'
                                        ? <><span className="spin" />создаём пробный поток…</>
                                        : 'Превью появится, когда адрес и порт будут валидны'}
                                </div>
                            </div>
                        )}

                        <div className="add-check">
                            <span className={`dot ${ipCheck.valid && portCheck.valid ? 'ok' : ''}`} />
                            {ipCheck.valid && portCheck.valid ? 'адрес и порт валидны' : 'введите адрес и порт'}
                        </div>
                        <div className="add-check">
                            <span className={`dot ${probeStatus === 'streaming' ? 'ok' : probeStatus === 'error' ? 'err' : ''}`} />
                            {probeStatus === 'streaming'
                                ? `канал ${form.main_sub} · поток идёт`
                                : probeStatus === 'error'
                                    ? `канал ${form.main_sub} · не отвечает`
                                    : `канал ${form.main_sub} · ждём проверку`}
                        </div>
                        <div className="add-check">
                            <span className="dot" />
                            канал {form.sub_sub} · проверится при добавлении
                        </div>

                        {probeStatus === 'error' && (
                            <button className="btn btn--sm" onClick={() => void startProbe(form)}>
                                Проверить ещё раз
                            </button>
                        )}

                        <p className="hint" style={{ marginTop: 'auto' }}>
                            Проверка создаёт временную камеру и удаляет её при закрытии окна.
                        </p>
                    </aside>

                    <div className="add-main">
                        <div className="add-sect">
                            <span className="eyebrow">Подключение</span>
                            <div className="add-row add-row--conn">
                                <div className="fcell">
                                    <span className="fcap">IP-адрес</span>
                                    <span className="pwd">
                                        <input
                                            className={`inp${ipCheck.valid || form.ip_adress === '' ? '' : ' is-err'}`}
                                            value={form.ip_adress}
                                            placeholder="192.168.1.52"
                                            onChange={e => onChange({ ip_adress: e.target.value.trim() })}
                                        />
                                        <button
                                            type="button"
                                            className="eye"
                                            onClick={() => setScanOpen(true)}
                                            title="Найти в сети"
                                            aria-label="Найти камеру в сети"
                                        >
                                            <Icon name="search" size={14} />
                                        </button>
                                    </span>
                                </div>
                                <F cap="Порт">
                                    <input
                                        className={`inp inp--num${portCheck.valid ? '' : ' is-err'}`}
                                        value={form.port}
                                        onChange={e => onChange({ port: e.target.value.trim() })}
                                    />
                                </F>
                                <F cap="Логин">
                                    <input
                                        className="inp"
                                        value={form.user}
                                        onChange={e => onChange({ user: e.target.value })}
                                    />
                                </F>
                                <div className="fcell">
                                    <span className="fcap">Пароль</span>
                                    <span className="pwd">
                                        <input
                                            className="inp"
                                            type={showPassword ? 'text' : 'password'}
                                            value={form.password}
                                            onChange={e => onChange({ password: e.target.value })}
                                        />
                                        <button
                                            type="button"
                                            className="eye"
                                            onClick={() => setShowPassword(v => !v)}
                                            aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                                        >
                                            <Icon name="eye" size={14} />
                                        </button>
                                    </span>
                                </div>
                            </div>
                            <div className="add-row add-row--meta">
                                <F cap="Имя (id)">
                                    <input
                                        className={`inp${nameCheck.valid ? '' : ' is-err'}`}
                                        style={{ fontFamily: 'var(--mono)' }}
                                        value={form.id}
                                        placeholder={autoName}
                                        onChange={e => onChange({ id: e.target.value })}
                                    />
                                </F>
                                <F cap="Отображаемое имя">
                                    <input
                                        className="inp"
                                        value={form.display_name}
                                        placeholder="как id"
                                        onChange={e => onChange({ display_name: e.target.value })}
                                    />
                                </F>
                                <F cap="Производитель">
                                    <Select
                                        value={String(form.production)}
                                        onChange={v => onChange({ production: Number(v) })}
                                        options={Object.entries(PRODUCTION_NAMES).map(([value, label]) => ({ value, label }))}
                                    />
                                </F>
                                <F cap="Тип камеры">
                                    <Select
                                        value={String(form.type)}
                                        onChange={v => onChange({ type: Number(v) })}
                                        options={Object.entries(TYPE_NAMES).map(([value, label]) => ({
                                            value,
                                            label,
                                            disabled: !types[Number(value)].ok,
                                            hint: types[Number(value)].ok ? undefined : types[Number(value)].reason,
                                        }))}
                                    />
                                </F>
                            </div>
                            {!nameCheck.valid && <p className="hint is-err" style={{ margin: 0 }}>{nameCheck.error}</p>}
                            {!ipCheck.valid && form.ip_adress !== '' && (
                                <p className="hint is-err" style={{ margin: 0 }}>{ipCheck.error}</p>
                            )}
                            {!portCheck.valid && <p className="hint is-err" style={{ margin: 0 }}>{portCheck.error}</p>}
                        </div>

                        <div className="add-sect">
                            <span className="eyebrow">Каналы</span>
                            <div className="add-chan">
                                <F cap="Канал 1">
                                    <input
                                        className="inp inp--num"
                                        type="number"
                                        value={form.main_sub}
                                        onChange={e => onChange({ main_sub: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </F>
                                <F cap="Задержка, мс">
                                    <input
                                        className="inp inp--num"
                                        type="number"
                                        value={form.main_latency}
                                        onChange={e => onChange({ main_latency: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </F>
                                <F cap="Реконнект, с">
                                    <input
                                        className="inp inp--num"
                                        type="number"
                                        value={form.main_reconnect}
                                        onChange={e => onChange({ main_reconnect: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </F>
                                <div className="fcell">
                                    <span className="fcap">UDP</span>
                                    <Switch on={form.main_use_udp} onToggle={v => onChange({ main_use_udp: v })}>{''}</Switch>
                                </div>
                            </div>
                            <div className="add-chan" style={{ marginBottom: 0 }}>
                                <F cap="Канал 2">
                                    <input
                                        className="inp inp--num"
                                        type="number"
                                        value={form.sub_sub}
                                        onChange={e => onChange({ sub_sub: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </F>
                                <F cap="Задержка, мс">
                                    <input
                                        className="inp inp--num"
                                        type="number"
                                        value={form.sub_latency}
                                        onChange={e => onChange({ sub_latency: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </F>
                                <F cap="Реконнект, с">
                                    <input
                                        className="inp inp--num"
                                        type="number"
                                        value={form.sub_reconnect}
                                        onChange={e => onChange({ sub_reconnect: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </F>
                                <div className="fcell">
                                    <span className="fcap">UDP</span>
                                    <Switch on={form.sub_use_udp} onToggle={v => onChange({ sub_use_udp: v })}>{''}</Switch>
                                </div>
                            </div>
                        </div>

                        <div className="add-sect" style={{ marginBottom: 0 }}>
                            <span className="eyebrow">Запись</span>
                            <div className="add-chan" style={{ marginBottom: 0 }}>
                                <div className="fcell">
                                    <span className="fcap">Писать в архив</span>
                                    <Switch on={form.to_record} onToggle={v => onChange({ to_record: v })}>{''}</Switch>
                                </div>
                                {form.to_record && (
                                    <F cap="Сегмент, с">
                                        <input
                                            className="inp inp--num"
                                            type="number"
                                            value={form.main_segment}
                                            onChange={e => onChange({ main_segment: parseInt(e.target.value, 10) || 0 })}
                                        />
                                    </F>
                                )}
                                <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>
                                    пишется канал 1 — на накопитель устройства-владельца
                                </span>
                            </div>
                        </div>

                        {error && (
                            <div className="banner is-err" style={{ marginTop: 14 }}>
                                <Icon name="warn" size={15} />
                                {error}
                            </div>
                        )}
                    </div>
                </div>

                <div className="modal-f">
                    <button className="btn btn--ghost" onClick={() => { void close(); }}>Отмена</button>
                    <span className="spacer" />
                    <button className="btn btn--acc" disabled={saving || !isValid} onClick={() => void save()}>
                        {saving ? 'Добавляем…' : 'Добавить камеру'}
                    </button>
                </div>
            </Modal>

            {scanOpen && (
                <ScanModal
                    cameras={cameras}
                    pickLabel="Выбрать"
                    onClose={() => setScanOpen(false)}
                    onPick={pickFromScan}
                />
            )}
        </>
    );
}
