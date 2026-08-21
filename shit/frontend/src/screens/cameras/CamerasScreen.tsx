import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { api } from '../../services/api';
import { getDevices, loadDevices, signalingWsUrl } from '../../services/devices';
import { AddCameraWizard } from './AddCameraWizard';
import { ConnectionFields, RecordFields, StreamFields } from './CameraFields';
import { LivePreview } from './LivePreview';
import { ScanModal } from './ScanModal';
import { StreamsTable } from './StreamsTable';
import { saveCamera } from './save';
import {
    RESERVED_PREFIXES,
    TYPE_NAMES,
    VENDOR_TO_PRODUCTION,
    cameraStatus,
    deviceOf,
    formFromCamera,
    formatError,
    ipToNumber,
    streamsOf,
    validateCameraName,
    validateIp,
    validatePort,
    type Camera,
    type CameraFormData,
    type StreamKey,
} from './model';
import './cameras.css';

const POLL_MS = 10_000;
type TypeFilter = 0 | 1 | 2 | 3;

interface ToastState {
    tone: 'ok' | 'err';
    text: string;
}

export function CamerasScreen() {
    const [cameras, setCameras] = useState<Camera[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [typeFilter, setTypeFilter] = useState<TypeFilter>(0);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [closing, setClosing] = useState(false);
    const [stream, setStream] = useState<StreamKey>('main');
    const [form, setForm] = useState<CameraFormData | null>(null);
    const [saving, setSaving] = useState(false);

    const [wizardOpen, setWizardOpen] = useState(false);
    const [wizardInitial, setWizardInitial] = useState<Partial<CameraFormData> | undefined>(undefined);
    const [scanOpen, setScanOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<Camera | null>(null);

    const [toast, setToast] = useState<ToastState | null>(null);
    const toastTimer = useRef<number | null>(null);

    const showToast = useCallback((tone: 'ok' | 'err', text: string) => {
        setToast({ tone, text });
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 4500);
    }, []);

    // Список камер: агрегированный /api/cameras несёт владельца и флаг offline,
    // WS такого не отдаёт — поэтому здесь опрос, как в старом экране
    const load = useCallback(async (silent = false) => {
        try {
            await loadDevices().catch(() => {});
            const { cameras: all } = await api.getSources();
            setCameras(all.filter(c => !RESERVED_PREFIXES.some(p => c.id.startsWith(p))));
        } catch (err) {
            if (!silent) showToast('err', formatError(err));
        } finally {
            setLoaded(true);
        }
    }, [showToast]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(true), POLL_MS);
        return () => window.clearInterval(timer);
    }, [load]);

    const sorted = useMemo(
        () => [...cameras].sort((a, b) => ipToNumber(a.ip_adress) - ipToNumber(b.ip_adress)),
        [cameras],
    );
    const visible = typeFilter === 0 ? sorted : sorted.filter(c => Number(c.type) === typeFilter);

    const liveCount = cameras.filter(c => cameraStatus(c).tone === 'ok').length;
    const troubled = cameras.length - liveCount;

    const selected = cameras.find(c => c.id === selectedId) ?? null;
    const selectedStreams = selected ? streamsOf(selected) : [];
    const selectedOffline = !!selected?.offline;

    // Закрытие отдаёт анимации доиграть: размонтирование — в finishClose
    const requestClose = () => {
        if (selectedId) setClosing(true);
    };
    const finishClose = () => {
        setSelectedId(null);
        setForm(null);
        setClosing(false);
    };

    // Форма заполняется при выборе камеры и не перетирается фоновым опросом
    const toggleCamera = (camera: Camera) => {
        if (camera.id === selectedId) {
            requestClose();
            return;
        }
        setClosing(false);
        setSelectedId(camera.id);
        setForm(formFromCamera(camera));
        setStream('main');
    };

    const existingNames = useMemo(() => cameras.map(c => c.id), [cameras]);
    const nameCheck = useMemo(
        () => validateCameraName(form?.id ?? '', existingNames, true),
        [form?.id, existingNames],
    );
    const ipCheck = useMemo(() => validateIp(form?.ip_adress ?? ''), [form?.ip_adress]);
    const portCheck = useMemo(() => validatePort(form?.port ?? ''), [form?.port]);
    const formValid = nameCheck.valid && ipCheck.valid && portCheck.valid;

    const dirty = useMemo(() => {
        if (!form || !selected) return false;
        return JSON.stringify(form) !== JSON.stringify(formFromCamera(selected));
    }, [form, selected]);

    const anyDeviceOnline = getDevices().some(d => d.status === 'online');

    // Подписи каналов в селекте те же, что в подтаблице
    const streamOptions = selectedStreams.map(s => ({
        key: s.key,
        label: s.width > 0 ? `${s.channel} · ${s.width}×${s.height}` : `${s.channel}`,
    }));

    const apply = async () => {
        if (!form || !selected || !formValid) return;
        setSaving(true);
        try {
            const result = await saveCamera(form, selected.id, selected);
            showToast(result.warning ? 'err' : 'ok', result.warning ?? result.message);
            await load(true);
            // Перечитываем форму из свежего списка: сервер мог поправить значения
            const fresh = (await api.getSources()).cameras.find(c => c.id === selected.id);
            if (fresh) setForm(formFromCamera(fresh));
        } catch (err) {
            showToast('err', formatError(err));
        } finally {
            setSaving(false);
        }
    };

    const doDelete = async () => {
        const camera = confirmDelete;
        if (!camera) return;
        setConfirmDelete(null);
        try {
            await api.deleteCamera(camera.id, deviceOf(camera));
            showToast('ok', `Камера ${camera.id} удалена`);
            if (selectedId === camera.id) {
                setSelectedId(null);
                setForm(null);
            }
            await load(true);
        } catch (err) {
            showToast('err', formatError(err));
        }
    };

    const openWizard = (initial?: Partial<CameraFormData>) => {
        setWizardInitial(initial);
        setScanOpen(false);
        setWizardOpen(true);
    };

    const patchForm = (patch: Partial<CameraFormData>) =>
        setForm(prev => (prev ? { ...prev, ...patch } : prev));

    return (
        <section className="screen">
            <div className="filters">
                <span className="fld"><span className="k">Всего</span><span className="v st-acc">{cameras.length}</span></span>
                <span className="fld">
                    <span className="k">В работе</span>
                    <span className={`v ${liveCount !== cameras.length ? 'st-warn' : 'st-ok'}`}>{liveCount}</span>
                </span>
                <span className="fld">
                    <span className="k">С проблемами</span>
                    <span className={`v ${troubled > 0 ? 'st-err' : 'st-ok'}`}>{troubled}</span>
                </span>

                <div className="seg">
                    {([[0, 'Все'], [1, 'Обычные'], [2, 'Тех. зрение'], [3, '360']] as const).map(([value, label]) => (
                        <button
                            key={value}
                            className={typeFilter === value ? 'is-on' : ''}
                            onClick={() => setTypeFilter(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <span className="spacer" />
                <button className="btn" onClick={() => setScanOpen(true)}>
                    <Icon name="search" size={16} />Сканировать сеть
                </button>
                <button
                    className="btn btn--acc"
                    disabled={!anyDeviceOnline}
                    title={anyDeviceOnline ? undefined : 'Добавление камеры возможно только при живом устройстве'}
                    onClick={() => openWizard()}
                >
                    <Icon name="plus" size={16} />Добавить камеру
                </button>
            </div>

            <div className="cams-body">
                <div className="cams-scroll">
                    {!loaded ? (
                        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div className="skel" style={{ width: '72%' }} />
                            <div className="skel" style={{ width: '58%' }} />
                            <div className="skel" style={{ width: '65%' }} />
                        </div>
                    ) : cameras.length === 0 ? (
                        <div className="empty" style={{ height: '100%' }}>
                            <Icon name="cam" size={34} />
                            <b>Камеры не добавлены</b>
                            <p>Найдите камеру сканом сети или добавьте её вручную по адресу RTSP.</p>
                            <div style={{ display: 'flex', gap: 9 }}>
                                <button className="btn btn--sm" onClick={() => setScanOpen(true)}>Сканировать сеть</button>
                                <button className="btn btn--sm btn--acc" disabled={!anyDeviceOnline} onClick={() => openWizard()}>
                                    Добавить камеру
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="cam-grid">
                            <div className="cam-head">
                                <span>Название</span>
                                <span>Тип</span>
                                <span>IP-адрес</span>
                                <span>Устройство</span>
                                <span>Задержка</span>
                                <span>Состояние</span>
                            </div>
                            {visible.map(camera => {
                                const status = cameraStatus(camera);
                                const open = camera.id === selectedId;
                                return (
                                    <div key={camera.id}>
                                        <div
                                            className={`cam-row${open ? ' is-open' : ''}`}
                                            onClick={() => toggleCamera(camera)}
                                        >
                                            <span className="nm">
                                                <span className="cam-name">
                                                    <Icon name="chev" size={12} className="chev" />
                                                    <i>{camera.display_name || camera.id}</i>
                                                </span>
                                            </span>
                                            <span>{TYPE_NAMES[camera.type] ?? '—'}</span>
                                            <span className="mono">{camera.ip_adress}</span>
                                            <span className={camera.offline ? 'st-err' : ''}>
                                                {camera.device_name ?? '—'}
                                            </span>
                                            <span className="mono">{camera.streams?.main?.latency ?? 0} мс</span>
                                            <span>
                                                <span className={`st st-${status.tone}`}>
                                                    <span className={`dot ${status.tone === 'info' ? 'acc' : status.tone === 'dim' ? '' : status.tone}`} />
                                                    {status.label}
                                                </span>
                                            </span>
                                        </div>
                                        {open && (
                                            <div className={`streams-wrap${closing ? ' is-closing' : ''}`}>
                                                <StreamsTable
                                                    camera={camera}
                                                    streams={selectedStreams}
                                                    selected={stream}
                                                    onSelect={setStream}
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {selected && form && (
                    <div
                        className={`drawer${closing ? ' is-closing' : ''}`}
                        onAnimationEnd={e => {
                            if (closing && e.animationName === 'drawer-out') finishClose();
                        }}
                    >
                        <div className="drawer-h">
                            <h2>{selected.display_name || selected.id}</h2>
                            <span className={`st st-${cameraStatus(selected).tone}`}>
                                <span className={`dot ${cameraStatus(selected).tone === 'ok' ? 'ok' : 'err'}`} />
                                {cameraStatus(selected).label}
                            </span>
                            <span className="num muted" style={{ fontSize: 11.5 }}>
                                {selected.id} · {selected.device_name ?? '—'}
                            </span>
                            <span className="spacer" />
                            {dirty && (
                                <button className="btn btn--sm btn--ghost" onClick={() => setForm(formFromCamera(selected))}>
                                    Сбросить
                                </button>
                            )}
                            <button
                                className="btn btn--sm btn--acc"
                                disabled={saving || !dirty || !formValid || selectedOffline}
                                onClick={() => void apply()}
                            >
                                {saving ? 'Сохраняем…' : 'Применить'}
                            </button>
                            <button
                                className="btn btn--sm btn--err"
                                disabled={selectedOffline}
                                onClick={() => setConfirmDelete(selected)}
                            >
                                Удалить
                            </button>
                            <button
                                className="icon-btn"
                                style={{ border: 'none' }}
                                onClick={requestClose}
                                aria-label="Закрыть настройки камеры"
                            >
                                <Icon name="x" size={14} />
                            </button>
                        </div>

                        <div className="drawer-b">
                            {selectedOffline ? (
                                <div className="cam-preview" style={{ flex: '0 0 340px' }}>
                                    <div className="state">
                                        Устройство «{selected.device_name}» не отвечает — показаны данные из кэша.
                                    </div>
                                </div>
                            ) : (
                                <LivePreview
                                    key={selected.id}
                                    cameraId={selected.id}
                                    signalingUrl={signalingWsUrl(deviceOf(selected), `/client/${selected.id}`)}
                                    caption={`канал ${stream === 'main' ? form.main_sub : form.sub_sub}`}
                                    style={{ flex: '0 0 340px' }}
                                />
                            )}

                            <div className="drawer-col" style={{ flex: '1 1 300px', maxWidth: 340 }}>
                                <span className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>Подключение</span>
                                <ConnectionFields
                                    form={form}
                                    onChange={patchForm}
                                    editMode
                                    autoName={selected.id}
                                    nameCheck={nameCheck}
                                    ipCheck={ipCheck}
                                    portCheck={portCheck}
                                />
                            </div>

                            <div className="drawer-col" style={{ flex: '1 1 240px', maxWidth: 240 }}>
                                <span className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>Поток</span>
                                <StreamFields
                                    form={form}
                                    onChange={patchForm}
                                    stream={stream}
                                    onStreamChange={setStream}
                                    options={streamOptions}
                                />
                            </div>

                            <div className="drawer-col" style={{ flex: '1 1 240px', maxWidth: 300 }}>
                                <span className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>
                                    Запись выбранного канала
                                </span>
                                <RecordFields form={form} onChange={patchForm} stream={stream} />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {wizardOpen && (
                <AddCameraWizard
                    cameras={cameras}
                    initial={wizardInitial}
                    onClose={() => setWizardOpen(false)}
                    onSaved={message => {
                        setWizardOpen(false);
                        showToast('ok', message);
                        void load(true);
                    }}
                />
            )}

            {scanOpen && (
                <ScanModal
                    cameras={cameras}
                    onClose={() => setScanOpen(false)}
                    onPick={found => openWizard({
                        ip_adress: found.ip,
                        ...(found.vendor && VENDOR_TO_PRODUCTION[found.vendor]
                            ? { production: VENDOR_TO_PRODUCTION[found.vendor] }
                            : {}),
                    })}
                />
            )}

            {confirmDelete && (
                <Modal
                    title={`Удалить камеру «${confirmDelete.display_name || confirmDelete.id}»?`}
                    onClose={() => setConfirmDelete(null)}
                    footer={
                        <>
                            <button className="btn btn--ghost" onClick={() => setConfirmDelete(null)}>Отмена</button>
                            <span className="spacer" />
                            <button className="btn btn--err" onClick={() => void doDelete()}>Удалить</button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <p className="hint" style={{ margin: 0 }}>
                            Камера будет удалена на устройстве-владельце. Записи в архиве останутся,
                            но новые сегменты писаться не будут.
                        </p>
                    </div>
                </Modal>
            )}

            {toast && (
                <div className="toast">
                    <span className={`dot ${toast.tone}`} />
                    <div>{toast.text}</div>
                    <button
                        className="icon-btn"
                        style={{ border: 'none', marginLeft: 6 }}
                        onClick={() => setToast(null)}
                        aria-label="Закрыть уведомление"
                    >
                        <Icon name="x" size={13} />
                    </button>
                </div>
            )}
        </section>
    );
}
