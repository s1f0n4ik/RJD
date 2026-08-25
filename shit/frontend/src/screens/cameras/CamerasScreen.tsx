import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal, isModalOpen } from '../../app/Modal';
import { api } from '../../services/api';
import { getDevices, loadDevices, signalingWsUrl } from '../../services/devices';
import type { StreamPurpose } from '../../types';
import { AddCameraWizard } from './AddCameraWizard';
import { AddStreamModal } from './AddStreamModal';
import { ConnectionFields, StreamFields, useDeviceModules } from './CameraFields';
import { LivePreview } from './LivePreview';
import { ScanModal } from './ScanModal';
import { PurposeChips, StreamsTable } from './StreamsTable';
import { saveCamera } from './save';
import {
    RESERVED_PREFIXES,
    VENDOR_TO_PRODUCTION,
    cameraStatus,
    deviceOf,
    formFromCamera,
    formatError,
    ipToNumber,
    makeStream,
    staleProbes,
    nextStreamKey,
    streamNumber,
    streamsOf,
    validateCameraName,
    validateIp,
    validatePort,
    validateStreams,
    viewableStream,
    type Camera,
    type CameraFormData,
    type StreamForm,
} from './model';
import './cameras.css';

const POLL_MS = 10_000;

type PurposeFilter = 'all' | StreamPurpose;

const FILTERS: Array<[PurposeFilter, string]> = [
    ['all', 'Все'],
    ['record', 'С записью'],
    ['neural', 'Тех. зрение'],
    ['birdview', '360'],
];

interface ToastState {
    tone: 'ok' | 'err';
    text: string;
}

/** Все назначения камеры без повторов — для колонки списка. */
const cameraPurposes = (camera: Camera): StreamPurpose[] => {
    const all = new Set<StreamPurpose>();
    for (const stream of streamsOf(camera)) {
        for (const purpose of stream.purposes) all.add(purpose);
    }
    return [...all];
};

export function CamerasScreen() {
    const [cameras, setCameras] = useState<Camera[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [purposeFilter, setPurposeFilter] = useState<PurposeFilter>('all');

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [closing, setClosing] = useState(false);
    const [streamKey, setStreamKey] = useState<string>('');
    const [form, setForm] = useState<CameraFormData | null>(null);
    const [saving, setSaving] = useState(false);

    const [wizardOpen, setWizardOpen] = useState(false);
    const [wizardInitial, setWizardInitial] = useState<Partial<CameraFormData> | undefined>(undefined);
    const [scanOpen, setScanOpen] = useState(false);
    const [addStreamOpen, setAddStreamOpen] = useState(false);
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

            /*
                Брошенные пробные камеры прятать мало: они держат сессию к камере
                и остаются невидимыми. Убираем фоном, отрисовку не задерживаем.
            */
            const stale = staleProbes(all);
            if (stale.length > 0) {
                console.warn(`[Камеры] убираем брошенные пробные камеры: ${stale.length}`);
                void Promise.allSettled(stale.map(c => api.deleteCamera(c.id, deviceOf(c))));
            }
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

    const visible = purposeFilter === 'all'
        ? sorted
        : sorted.filter(c => cameraPurposes(c).includes(purposeFilter));

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

    // Esc закрывает шторку, но уступает модалкам: пока открыто подтверждение,
    // скан или мастер, клавиша принадлежит верхнему окну
    useEffect(() => {
        if (!selectedId) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isModalOpen()) setClosing(true);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [selectedId]);

    /*
        Камера пропала из ответа API — её удалили, держать шторку не на чем.
        Фильтр списка сюда не относится: cameras остаётся полным набором,
        сужается только visible.
    */
    useEffect(() => {
        if (!loaded || !selectedId) return;
        if (!cameras.some(c => c.id === selectedId)) finishClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cameras, loaded, selectedId]);

    // Форма заполняется при выборе камеры и не перетирается фоновым опросом
    const toggleCamera = (camera: Camera) => {
        if (camera.id === selectedId) {
            requestClose();
            return;
        }
        setClosing(false);
        setSelectedId(camera.id);
        setForm(formFromCamera(camera));
        // Открываем на смотрибельном потоке: рядом живое превью
        setStreamKey(viewableStream(camera)?.key ?? streamsOf(camera)[0]?.key ?? '');
    };

    const existingNames = useMemo(() => cameras.map(c => c.id), [cameras]);
    const nameCheck = useMemo(
        () => validateCameraName(form?.id ?? '', existingNames, true),
        [form?.id, existingNames],
    );
    const ipCheck = useMemo(() => validateIp(form?.ip_adress ?? ''), [form?.ip_adress]);
    const portCheck = useMemo(() => validatePort(form?.port ?? ''), [form?.port]);

    const modules = useDeviceModules(form?.device_id ?? '');
    const streamsCheck = useMemo(
        () => validateStreams(form?.streams ?? [], modules),
        [form?.streams, modules],
    );

    const formValid = nameCheck.valid && ipCheck.valid && portCheck.valid && streamsCheck.valid;

    const dirty = useMemo(() => {
        if (!form || !selected) return false;
        return JSON.stringify(form) !== JSON.stringify(formFromCamera(selected));
    }, [form, selected]);

    const anyDeviceOnline = getDevices().some(d => d.status === 'online');

    // Подписи потоков в селекте: разрешение показываем, когда поток живой
    const streamLabels = useMemo(() => {
        const labels: Record<string, string> = {};
        for (const stream of selectedStreams) {
            labels[stream.key] = stream.width > 0
                ? `Поток ${stream.number} · ${stream.width}×${stream.height}`
                : `Поток ${stream.number} · субпоток ${stream.substream}`;
        }
        for (const stream of form?.streams ?? []) {
            if (!labels[stream.key]) {
                labels[stream.key] = `Поток ${streamNumber(stream.key)} · субпоток ${stream.substream}`;
            }
        }
        return labels;
    }, [selectedStreams, form?.streams]);

    const patchForm = (patch: Partial<CameraFormData>) =>
        setForm(prev => (prev ? { ...prev, ...patch } : prev));

    const patchStream = (key: string, patch: Partial<StreamForm>) =>
        setForm(prev => prev
            ? { ...prev, streams: prev.streams.map(s => (s.key === key ? { ...s, ...patch } : s)) }
            : prev);

    // Номер субпотока приходит из опроса камеры, а не назначается по порядку
    const pickStream = (found: { substream: number }) => {
        const substream = found.substream;
        setAddStreamOpen(false);
        setForm(prev => {
            if (!prev) return prev;
            const key = nextStreamKey(prev.streams);
            // Новый поток заводится смотрибельным: это единственное назначение,
            // доступное на любом устройстве
            const stream = makeStream(key, substream, ['view']);
            setStreamKey(key);
            return { ...prev, streams: [...prev.streams, stream] };
        });
    };

    const removeStream = (key: string) => setForm(prev => {
        if (!prev || prev.streams.length <= 1) return prev;
        const streams = prev.streams.filter(s => s.key !== key);
        setStreamKey(streams[0].key);
        return { ...prev, streams };
    });

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

    const previewStream = selectedStreams.find(s => s.key === streamKey);
    const previewKey = previewStream?.purposes.includes('view')
        ? previewStream.key
        : viewableStream(selected ?? ({} as Camera))?.key;

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
                    {FILTERS.map(([value, label]) => (
                        <button
                            key={value}
                            className={purposeFilter === value ? 'is-on' : ''}
                            onClick={() => setPurposeFilter(value)}
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
                                <span>Назначения</span>
                                <span>IP-адрес</span>
                                <span>Устройство</span>
                                <span>Потоков</span>
                                <span>Состояние</span>
                            </div>
                            {visible.map(camera => {
                                const status = cameraStatus(camera);
                                const open = camera.id === selectedId;
                                const streams = streamsOf(camera);
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
                                            <span className="cell-purp"><PurposeChips purposes={cameraPurposes(camera)} /></span>
                                            <span className="mono">{camera.ip_adress}</span>
                                            <span className={camera.offline ? 'st-err' : ''}>
                                                {camera.device_name ?? '—'}
                                            </span>
                                            <span className="mono">{streams.length}</span>
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
                                                    selected={streamKey}
                                                    onSelect={setStreamKey}
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
                            <div className="drawer-who">
                                <h2>{selected.display_name || selected.id}</h2>
                                <span className="sub">{selected.id} · {selected.device_name ?? '—'}</span>
                            </div>
                            <span className="spacer" />
                            <span className={`st st-${cameraStatus(selected).tone}`}>
                                <span className={`dot ${cameraStatus(selected).tone === 'ok' ? 'ok' : 'err'}`} />
                                {cameraStatus(selected).label}
                            </span>
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
                                <div className="cam-preview">
                                    <div className="state">
                                        Устройство «{selected.device_name}» не отвечает — показаны данные из кэша.
                                    </div>
                                </div>
                            ) : previewKey ? (
                                <LivePreview
                                    key={`${selected.id}:${previewKey}`}
                                    cameraId={selected.id}
                                    stream={previewKey}
                                    signalingUrl={signalingWsUrl(deviceOf(selected), `/client/${selected.id}`)}
                                    caption={streamLabels[previewKey] ?? previewKey}
                                />
                            ) : (
                                <div className="cam-preview">
                                    <div className="state">
                                        Ни одному потоку не назначен просмотр — смотреть нечего.
                                    </div>
                                </div>
                            )}

                            <div className="drawer-col">
                                <span className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>Потоки</span>
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
                                {!streamsCheck.valid && (
                                    <p className="hint is-err" style={{ marginTop: 10 }}>{streamsCheck.error}</p>
                                )}
                            </div>

                            <div className="drawer-col">
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
                        </div>

                        <div className="drawer-f">
                            <button
                                className="btn btn--sm btn--err"
                                disabled={selectedOffline}
                                onClick={() => setConfirmDelete(selected)}
                            >
                                Удалить
                            </button>
                            <span className="spacer" />
                            {dirty && (
                                <button className="btn btn--sm btn--ghost" onClick={() => setForm(formFromCamera(selected))}>
                                    Сбросить
                                </button>
                            )}
                            <button
                                className="btn btn--sm btn--acc"
                                disabled={saving || !dirty || !formValid || selectedOffline}
                                title={formValid ? undefined : streamsCheck.error}
                                onClick={() => void apply()}
                            >
                                {saving ? 'Сохраняем…' : 'Применить'}
                            </button>
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

            {addStreamOpen && form && (
                <AddStreamModal
                    deviceId={form.device_id || deviceOf(selected)}
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
