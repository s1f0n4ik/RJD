import { useMemo, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { Select } from '../../app/Select';
import { api } from '../../services/api';
import { getDevices } from '../../services/devices';
import { AddStreamModal } from './AddStreamModal';
import { StreamFields, useDeviceModules } from './CameraFields';
import { ScanModal } from './ScanModal';
import {
    DEFAULT_FORM,
    PRODUCTION_NAMES,
    VENDOR_TO_PRODUCTION,
    findNextFreeCameraId,
    formToPayload,
    formatError,
    makeStream,
    nextStreamKey,
    validateCameraName,
    validateIp,
    validatePort,
    validateStreams,
    type Camera,
    type CameraFormData,
    type StreamForm,
} from './model';

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
    const devices = getDevices();
    const firstOnline = devices.find(d => d.status === 'online')?.id ?? '';

    const [form, setForm] = useState<CameraFormData>({
        ...DEFAULT_FORM,
        device_id: firstOnline,
        ...initial,
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [scanOpen, setScanOpen] = useState(false);
    const [addStreamOpen, setAddStreamOpen] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [streamKey, setStreamKey] = useState('');

    const onChange = (patch: Partial<CameraFormData>) => setForm(prev => ({ ...prev, ...patch }));

    const autoName = useMemo(() => findNextFreeCameraId(cameras), [cameras]);
    const existingNames = useMemo(() => cameras.map(c => c.id), [cameras]);
    const nameCheck = useMemo(() => validateCameraName(form.id, existingNames, false), [form.id, existingNames]);
    const ipCheck = useMemo(() => validateIp(form.ip_adress), [form.ip_adress]);
    const portCheck = useMemo(() => validatePort(form.port), [form.port]);

    const modules = useDeviceModules(form.device_id);
    const streamsCheck = useMemo(() => validateStreams(form.streams, modules), [form.streams, modules]);

    // Опрашивать нечего, пока не известно куда идти и с какого устройства
    const canProbe = ipCheck.valid && portCheck.valid && !!form.device_id;
    const isValid = nameCheck.valid && ipCheck.valid && portCheck.valid && streamsCheck.valid && !!form.device_id;

    const patchStream = (key: string, patch: Partial<StreamForm>) =>
        setForm(prev => ({
            ...prev,
            streams: prev.streams.map(s => (s.key === key ? { ...s, ...patch } : s)),
        }));

    // Номер субпотока приходит из опроса камеры, а не назначается по порядку
    const pickStream = (substream: number) => {
        setAddStreamOpen(false);
        setForm(prev => {
            const key = nextStreamKey(prev.streams);
            setStreamKey(key);
            return { ...prev, streams: [...prev.streams, makeStream(key, substream, ['view'])] };
        });
    };

    const removeStream = (key: string) => setForm(prev => {
        const streams = prev.streams.filter(s => s.key !== key);
        setStreamKey(streams[0]?.key ?? '');
        return { ...prev, streams };
    });

    const save = async () => {
        if (!isValid) return;
        setSaving(true);
        setError('');
        const cameraId = form.id || autoName;
        try {
            await api.createCamera(formToPayload(form, cameraId), form.device_id);
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

    const streamLabels = useMemo(() => {
        const labels: Record<string, string> = {};
        for (const stream of form.streams) {
            labels[stream.key] = `Субпоток ${stream.substream}`;
        }
        return labels;
    }, [form.streams]);

    const deviceName = devices.find(d => d.id === form.device_id)?.name;

    return (
        <>
            <Modal
                title="Добавить камеру"
                className="add-modal"
                onClose={onClose}
                head={deviceName
                    ? <span className="num muted" style={{ fontSize: 11 }}>будет создана на {deviceName}</span>
                    : undefined}
            >
                <div className="add-body">
                    <aside className="add-side">
                        <span className="eyebrow">Готовность</span>

                        <div className="add-check">
                            <span className={`dot ${ipCheck.valid && portCheck.valid ? 'ok' : ''}`} />
                            {ipCheck.valid && portCheck.valid ? 'адрес и порт валидны' : 'введите адрес и порт'}
                        </div>
                        <div className="add-check">
                            <span className={`dot ${form.device_id ? 'ok' : ''}`} />
                            {form.device_id ? 'устройство выбрано' : 'выберите устройство'}
                        </div>
                        <div className="add-check">
                            <span className={`dot ${form.streams.length > 0 ? 'ok' : ''}`} />
                            {form.streams.length > 0
                                ? `потоков добавлено: ${form.streams.length}`
                                : 'потоки не добавлены'}
                        </div>

                        <p className="hint" style={{ marginTop: 'auto' }}>
                            Потоки добавляются опросом камеры: media-center подключается к ней,
                            читает параметры и показывает субпотоки, с которых реально идёт видео.
                            Камера при этом не создаётся.
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
                                <F cap="Устройство">
                                    <Select
                                        value={form.device_id}
                                        onChange={v => onChange({ device_id: v })}
                                        options={devices.map(d => ({
                                            value: d.id,
                                            label: d.name || d.id,
                                            disabled: d.status !== 'online',
                                            hint: d.status === 'online' ? d.modules.join(', ') || 'без модулей' : 'не в сети',
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

                        <div className="add-sect" style={{ marginBottom: 0 }}>
                            <span className="eyebrow">Потоки</span>
                            {canProbe ? (
                                <>
                                    <StreamFields
                                        streams={form.streams}
                                        selected={streamKey}
                                        modules={modules}
                                        onSelect={setStreamKey}
                                        onPatch={patchStream}
                                        onAdd={() => setAddStreamOpen(true)}
                                        onRemove={removeStream}
                                        labels={streamLabels}
                                    />
                                    {form.streams.length > 0 && !streamsCheck.valid && (
                                        <p className="hint is-err" style={{ marginTop: 10 }}>{streamsCheck.error}</p>
                                    )}
                                </>
                            ) : (
                                <p className="hint" style={{ margin: 0 }}>
                                    Заполните адрес, порт и устройство — тогда камеру можно будет опросить
                                    и выбрать субпотоки.
                                </p>
                            )}
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
                    <button className="btn btn--ghost" onClick={onClose}>Отмена</button>
                    <span className="spacer" />
                    <button
                        className="btn btn--acc"
                        disabled={saving || !isValid}
                        title={isValid ? undefined : streamsCheck.error}
                        onClick={() => void save()}
                    >
                        {saving ? 'Добавляем…' : 'Добавить камеру'}
                    </button>
                </div>
            </Modal>

            {addStreamOpen && (
                <AddStreamModal
                    deviceId={form.device_id}
                    connection={{
                        ip_adress: form.ip_adress,
                        port: form.port,
                        user: form.user,
                        password: form.password,
                        production: form.production,
                    }}
                    used={form.streams.map(s => s.substream)}
                    onPick={pickStream}
                    onClose={() => setAddStreamOpen(false)}
                />
            )}

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
