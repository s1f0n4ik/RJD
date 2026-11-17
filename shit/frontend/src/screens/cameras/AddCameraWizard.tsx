import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal, Seg } from '../../app/Modal';
import { Select } from '../../app/Select';
import { api } from '../../services/api';
import { defaultCameraDeviceId, getDevices, mcPath, signalingWsUrl } from '../../services/devices';
import { MODULE_LABEL } from '../devices/model';
import type { LocalCamera, StreamPurpose } from '../../types';
import { AddStreamModal, type FoundStream } from './AddStreamModal';
import { PurposePicker, useDeviceModules } from './CameraFields';
import { EncodeFields, LocalCameraList, ModeFields, useLocalCameras } from './LocalCameraFields';
import { LivePreview } from './LivePreview';
import { ScanModal } from './ScanModal';
import {
    DEFAULT_FORM,
    LOCAL_STREAM,
    PRODUCTION_NAMES,
    VENDOR_TO_PRODUCTION,
    findNextFreeCameraId,
    formToPayload,
    formatError,
    makeStream,
    modeError,
    modeFor,
    nextStreamKey,
    togglePurpose,
    validateCameraName,
    validateIp,
    validatePort,
    validateStreams,
    validateV4l2,
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

/** Единственный поток временной камеры предпросмотра. */
const PREVIEW_STREAM = 'stream_1';

// Ожидание готовности потока перед показом плеера
const READY_POLL_MS = 700;
const READY_TIMEOUT_MS = 20_000;
const STATUS_PLAYING = 3;

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
    const online = devices.filter(d => d.status === 'online');
    // Умолчание из маршрутизации; если это устройство молчит — первое живое
    const routed = defaultCameraDeviceId();
    const defaultDevice = online.find(d => d.id === routed)?.id ?? online[0]?.id ?? '';

    const [form, setForm] = useState<CameraFormData>({
        ...DEFAULT_FORM,
        device_id: defaultDevice,
        ...initial,
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [scanOpen, setScanOpen] = useState(false);
    const [addStreamOpen, setAddStreamOpen] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    // Что опрос узнал о добавленных субпотоках: показывается в карточках
    const [probed, setProbed] = useState<Record<number, FoundStream>>({});

    const [previewName, setPreviewName] = useState<string | null>(null);
    const [previewBusy, setPreviewBusy] = useState(false);
    const [previewError, setPreviewError] = useState('');
    // Имя и устройство временной камеры переживают ререндеры: по ним её убирать
    const previewRef = useRef<{ name: string; device: string } | null>(null);
    // Номер запуска: отсекает поздние ответы create и delete друг от друга
    const previewRunRef = useRef(0);
    // Ключ подключения, с которым сессию открыли: с ним и сверяемся
    const previewKeyRef = useRef('');

    // Указатель прокрутки вместо полосы: показывается, пока ниже есть контент
    const mainRef = useRef<HTMLDivElement>(null);
    const [hasMore, setHasMore] = useState(false);

    const syncMore = useCallback(() => {
        const el = mainRef.current;
        if (!el) return;
        // Запас в пиксель: дробные высоты иначе держат стрелку у самого низа
        setHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
    }, []);

    // Следим за областью и её блоками: содержимое растёт с каждым потоком
    useEffect(() => {
        const el = mainRef.current;
        if (!el) return;

        syncMore();

        const observer = new ResizeObserver(syncMore);
        observer.observe(el);
        for (const child of Array.from(el.children)) observer.observe(child);

        return () => observer.disconnect();
    }, [syncMore]);

    const onChange = (patch: Partial<CameraFormData>) => setForm(prev => ({ ...prev, ...patch }));

    const autoName = useMemo(() => findNextFreeCameraId(cameras), [cameras]);
    const existingNames = useMemo(() => cameras.map(c => c.id), [cameras]);
    const nameCheck = useMemo(() => validateCameraName(form.id, existingNames, false), [form.id, existingNames]);
    const ipCheck = useMemo(() => validateIp(form.ip_adress), [form.ip_adress]);
    const portCheck = useMemo(() => validatePort(form.port), [form.port]);

    const modules = useDeviceModules(form.device_id);
    const streamsCheck = useMemo(() => validateStreams(form.streams, modules), [form.streams, modules]);

    // Камера на плате: список камер устройства и режим, который выбранная камера умеет
    const local = form.source === 'v4l2';
    const boardCameras = useLocalCameras(form.device_id, local);
    const picked = boardCameras.cameras.find(c => c.device === form.v4l2.device);
    const v4l2Check = useMemo(() => validateV4l2(form.v4l2), [form.v4l2]);
    const modeProblem = picked ? modeError(picked, form.v4l2) : '';
    const localReady = !!picked && v4l2Check.valid && !modeProblem;

    // Опрашивать нечего, пока не известно куда идти и с какого устройства
    const canProbe = ipCheck.valid && portCheck.valid && !!form.device_id;
    const sourceValid = local ? localReady : ipCheck.valid && portCheck.valid;
    const isValid = nameCheck.valid && sourceValid && streamsCheck.valid && !!form.device_id;

    const viewStream = form.streams.find(s => s.purposes.includes('view')) ?? null;

    // ── Предпросмотр ──────────────────────────────────────────────────────
    // Просмотр идёт через временную камеру с префиксом __probe_
    const stopPreview = useCallback(async (reason: string) => {
        previewRunRef.current++;

        const current = previewRef.current;
        previewRef.current = null;
        previewKeyRef.current = '';
        setPreviewName(null);

        if (!current) return;

        // Причина в консоли: иначе непонятно, кто погасил превью
        console.warn(`[Мастер камеры] превью остановлено — ${reason}`);

        try {
            await api.deleteCamera(current.name, current.device);
        } catch {
            // временная камера, молча
        }
    }, []);

    /** Ждёт, пока поток временной камеры перейдёт в «работает». */
    const waitForStream = async (name: string, device: string, run: number): Promise<boolean> => {
        const deadline = Date.now() + READY_TIMEOUT_MS;

        while (Date.now() < deadline) {
            if (previewRunRef.current !== run) return false;

            try {
                const camera = await api.getCamera(name, device);
                if (camera?.streams?.[PREVIEW_STREAM]?.status === STATUS_PLAYING) return true;
            } catch {
                // камера ещё поднимается, пробуем снова
            }

            await new Promise(resolve => window.setTimeout(resolve, READY_POLL_MS));
        }

        return false;
    };

    const startPreview = async () => {
        if (!viewStream || !form.device_id) return;

        const run = ++previewRunRef.current;
        const device = form.device_id;

        setPreviewError('');
        setPreviewBusy(true);

        const name = `__probe_${Date.now()}`;
        const single: StreamForm = { ...viewStream, key: PREVIEW_STREAM, purposes: ['view'] };
        const payload = formToPayload({ ...form, streams: [single] }, name);
        payload.display_name = `Проверка ${local ? picked?.name ?? form.v4l2.device : form.ip_adress}`;
        payload.description = 'Временная камера предпросмотра';

        try {
            await api.createCamera(payload, device);

            // За время запроса просмотр могли отменить
            if (previewRunRef.current !== run) {
                await api.deleteCamera(name, device).catch(() => {});
                return;
            }

            previewRef.current = { name, device };
            previewKeyRef.current = previewKey;

            const ready = await waitForStream(name, device, run);
            if (previewRunRef.current !== run) return;

            if (!ready) {
                await stopPreview('поток так и не пошёл');
                setPreviewError('Поток не пошёл — камера не отдала видео по этому субпотоку');
                return;
            }

            setPreviewName(name);
        } catch (err) {
            if (previewRunRef.current === run) setPreviewError(formatError(err));
        } finally {
            if (previewRunRef.current === run) setPreviewBusy(false);
        }
    };

    // Смена подключения или пропажа смотрибельного потока обесценивают сессию
    const previewKey = [
        form.source, form.ip_adress, form.port, form.user, form.password, form.production,
        form.device_id, viewStream?.substream ?? 0, local ? JSON.stringify(form.v4l2) : '',
    ].join('|');

    useEffect(() => {
        // Гасим только при смене того, из чего собрана ссылка
        if (previewRef.current && previewKeyRef.current && previewKeyRef.current !== previewKey) {
            void stopPreview('изменились параметры подключения');
        }
    }, [previewKey, stopPreview]);

    useEffect(() => () => { void stopPreview('окно закрыто'); }, [stopPreview]);

    // Закрытие вкладки на середине просмотра: keepalive переживает unload
    useEffect(() => {
        const handler = () => {
            const current = previewRef.current;
            if (!current) return;
            fetch(mcPath(current.device, `/camera?id=${encodeURIComponent(current.name)}`), {
                method: 'DELETE',
                keepalive: true,
            }).catch(() => {});
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    // ── Потоки ────────────────────────────────────────────────────────────
    const patchStream = (key: string, patch: Partial<StreamForm>) =>
        setForm(prev => ({
            ...prev,
            streams: prev.streams.map(s => (s.key === key ? { ...s, ...patch } : s)),
        }));

    // Номер субпотока приходит из опроса камеры, а не назначается по порядку
    const pickStreams = (found: FoundStream[]) => {
        setAddStreamOpen(false);
        setProbed(prev => Object.fromEntries([...Object.entries(prev), ...found.map(f => [f.substream, f])]));
        setForm(prev => {
            const streams = [...prev.streams];
            for (const f of found) streams.push(makeStream(nextStreamKey(streams), f.substream, ['view']));
            return { ...prev, streams };
        });
    };

    // Уже заведённые потоки в модалке: что опрос узнал, иначе только номер
    const existingStreams = (): FoundStream[] => form.streams.map(s =>
        probed[s.substream] ?? { substream: s.substream, width: 0, height: 0, codec: '', fps: 0 });

    const removeStream = (key: string) =>
        setForm(prev => ({ ...prev, streams: prev.streams.filter(s => s.key !== key) }));

    // У камеры на плате ровно один поток, у сетевой потоки набираются опросом
    const setSource = (source: 'rtsp' | 'v4l2') => {
        if (source === form.source) return;
        void stopPreview('сменился источник камеры');
        setProbed({});
        setForm(prev => ({
            ...prev,
            source,
            streams: source === 'v4l2' ? [makeStream(LOCAL_STREAM, 1, ['view'])] : [],
        }));
    };

    // Новая камера платы: формат прежний, если камера его отдаёт, размер и частота — из её списка
    const pickBoardCamera = (camera: LocalCamera) =>
        setForm(prev => ({ ...prev, v4l2: modeFor(camera, prev.v4l2.format, prev.v4l2) }));

    // Камеры другой платы — другие: прежний выбор снимается
    const pickDevice = (deviceId: string) =>
        onChange({ device_id: deviceId, v4l2: { ...form.v4l2, device: '' } });

    const save = async () => {
        if (!isValid) return;
        setSaving(true);
        setError('');
        const cameraId = form.id || autoName;
        try {
            await stopPreview('камера сохраняется');
            await api.createCamera(formToPayload(form, cameraId), form.device_id);
            onSaved(`Камера ${cameraId} добавлена`);
        } catch (err) {
            setError(formatError(err));
        } finally {
            setSaving(false);
        }
    };

    const close = async () => {
        await stopPreview('окно закрыто');
        onClose();
    };

    // Скан из мастера: «Выбрать» заносит адрес и вендора в форму
    const pickFromScan = (found: { ip: string; vendor: string | null }) => {
        const production = found.vendor ? VENDOR_TO_PRODUCTION[found.vendor] : undefined;
        onChange({ ip_adress: found.ip, ...(production ? { production } : {}) });
        setScanOpen(false);
    };

    const deviceName = devices.find(d => d.id === form.device_id)?.name;

    // Куски подписи потока — разделитель между ними рисует css
    const describe = (stream: StreamForm): string[] => {
        const info = probed[stream.substream];
        if (!info || !info.width) return ['параметры неизвестны'];
        return [
            `${info.width}×${info.height}`,
            info.codec ? info.codec.toUpperCase() : null,
            info.fps ? `${info.fps} к/с` : null,
        ].filter((v): v is string => v !== null);
    };

    return (
        <>
            <Modal
                title="Добавить камеру"
                className="add-modal"
                onClose={() => { void close(); }}
                head={deviceName
                    ? <span className="num muted" style={{ fontSize: 11 }}>будет создана на {deviceName}</span>
                    : undefined}
            >
                <div className="add-body">
                    <aside className="add-side">
                        <span className="eyebrow">Просмотр</span>

                        {previewName && form.device_id ? (
                            <LivePreview
                                key={previewName}
                                cameraId={previewName}
                                stream={PREVIEW_STREAM}
                                signalingUrl={signalingWsUrl(form.device_id, `/client/${previewName}`)}
                                caption={local
                                    ? `${form.v4l2.format} ${form.v4l2.width}×${form.v4l2.height}`
                                    : viewStream ? `субпоток ${viewStream.substream}` : undefined}
                                style={{ flex: 'none', width: '100%' }}
                            />
                        ) : (
                            <div className="cam-preview" style={{ flex: 'none', width: '100%' }}>
                                <div className="state">
                                    {previewBusy
                                        ? <><span className="spin" />поднимаем поток на устройстве…</>
                                        : previewError
                                            ? previewError
                                            : local
                                                ? picked
                                                    ? (
                                                        <>
                                                            <span className="seps">
                                                                <span>{picked.kind.toUpperCase()}</span>
                                                                <span>{form.v4l2.format} {form.v4l2.width}×{form.v4l2.height}</span>
                                                            </span>
                                                            <span>нажмите «Показать превью»</span>
                                                        </>
                                                    )
                                                    : 'Появится, когда будет выбрана камера'
                                            : viewStream
                                                ? (
                                                    <span className="seps">
                                                        <span>Субпоток {viewStream.substream}</span>
                                                        <span>нажмите «Показать превью»</span>
                                                    </span>
                                                )
                                                : 'Появится, когда у камеры будет поток с назначением «Просмотр»'}
                                </div>
                            </div>
                        )}

                        <button
                            className="btn"
                            style={{ width: '100%', justifyContent: 'center' }}
                            disabled={!viewStream || previewBusy || !form.device_id || (local && !localReady)}
                            onClick={() => (previewName ? void stopPreview('остановлено оператором') : void startPreview())}
                        >
                            {previewBusy
                                ? 'Поднимаем поток…'
                                : previewName ? 'Остановить превью' : 'Показать превью'}
                        </button>

                        {local ? (
                            <>
                                <div className="add-check">
                                    <span className={`dot ${picked ? 'ok' : ''}`} />
                                    {picked ? 'камера выбрана' : 'выберите камеру платы'}
                                </div>
                                <div className="add-check">
                                    <span className={`dot ${localReady ? 'ok' : ''}`} />
                                    {!picked ? 'режим не выбран' : localReady ? 'режим есть у камеры' : modeProblem || v4l2Check.error}
                                </div>
                            </>
                        ) : (
                            <div className="add-check">
                                <span className={`dot ${ipCheck.valid && portCheck.valid ? 'ok' : ''}`} />
                                {ipCheck.valid && portCheck.valid ? 'адрес и порт валидны' : 'введите адрес и порт'}
                            </div>
                        )}
                        <div className="add-check">
                            <span className={`dot ${form.device_id ? 'ok' : ''}`} />
                            {form.device_id ? 'устройство выбрано' : 'выберите устройство'}
                        </div>
                        {!local && (
                            <div className="add-check">
                                <span className={`dot ${form.streams.length > 0 ? 'ok' : ''}`} />
                                {form.streams.length > 0
                                    ? `потоков добавлено: ${form.streams.length}`
                                    : 'потоки не добавлены'}
                            </div>
                        )}
                    </aside>

                    <div className="add-pane">
                    <div className="add-main" ref={mainRef} onScroll={syncMore}>
                        <div className="add-block">
                            <div className="add-block-h">
                                <span className="t">Подключение</span>
                                <span className="spacer" />
                                {local && (
                                    <button type="button" className="btn btn--sm btn--ghost" onClick={boardCameras.reload} data-tip="Опросить плату заново">
                                        <Icon name="refresh" size={13} />Обновить
                                    </button>
                                )}
                                <Seg className="seg--xs" title="Где камера">
                                    <button type="button" className={local ? '' : 'is-on'} onClick={() => setSource('rtsp')}>В сети</button>
                                    <button type="button" className={local ? 'is-on' : ''} onClick={() => setSource('v4l2')}>На плате</button>
                                </Seg>
                            </div>
                            <div className="add-block-b">
                                {!local && (
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
                                                    data-tip="Найти в сети"
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
                                )}
                                <div className="add-row add-row--meta" style={local ? { marginBottom: 0, gridTemplateColumns: '1fr 1.4fr 1.2fr' } : { marginBottom: 0 }}>
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
                                    {!local && (
                                        <F cap="Производитель">
                                            <Select
                                                value={String(form.production)}
                                                onChange={v => onChange({ production: Number(v) })}
                                                options={Object.entries(PRODUCTION_NAMES).map(([value, label]) => ({ value, label }))}
                                            />
                                        </F>
                                    )}
                                    <F cap="Устройство">
                                        <Select
                                            value={form.device_id}
                                            onChange={pickDevice}
                                            options={devices.map(d => ({
                                                value: d.id,
                                                label: d.name || d.id,
                                                disabled: d.status !== 'online',
                                                hint: d.status === 'online'
                                                    ? d.modules.map(m => MODULE_LABEL[m] ?? m).join(' · ') || 'только камеры'
                                                    : 'не в сети',
                                            }))}
                                        />
                                    </F>
                                </div>
                                {!nameCheck.valid && <p className="hint is-err" style={{ marginTop: 10 }}>{nameCheck.error}</p>}
                                {!local && !ipCheck.valid && form.ip_adress !== '' && (
                                    <p className="hint is-err" style={{ marginTop: 10 }}>{ipCheck.error}</p>
                                )}
                                {!local && !portCheck.valid && <p className="hint is-err" style={{ marginTop: 10 }}>{portCheck.error}</p>}
                                {local && (
                                    <div style={{ marginTop: 12 }}>
                                        <LocalCameraList list={boardCameras} deviceName={deviceName ?? form.device_id} value={form.v4l2.device} onPick={pickBoardCamera} />
                                    </div>
                                )}
                            </div>
                        </div>

                        {local && picked && (
                            <>
                                <div className="add-block">
                                    <div className="add-block-h"><span className="t">Режим</span></div>
                                    <div className="add-block-b">
                                        <ModeFields value={form.v4l2} camera={picked} onChange={v4l2 => onChange({ v4l2 })} />
                                        {!localReady && <p className="hint is-err" style={{ marginTop: 10 }}>{modeProblem || v4l2Check.error}</p>}
                                    </div>
                                </div>
                                <div className="add-block">
                                    <div className="add-block-h"><span className="t">Кодирование</span></div>
                                    <div className="add-block-b"><EncodeFields value={form.v4l2} onChange={v4l2 => onChange({ v4l2 })} /></div>
                                </div>
                                <div className="add-block">
                                    <div className="add-block-h"><span className="t">Поток</span><span className="count">1</span></div>
                                    <div className="add-block-b">
                                        <div className="scards">
                                            {form.streams.map(stream => (
                                                <div className="scard" key={stream.key}>
                                                    <span className="plate"><b>1</b><i>поток</i></span>
                                                    <span className="who">
                                                        <span className="n">
                                                            <span className="seps">
                                                                <span>{form.v4l2.rotation % 180 ? `${form.v4l2.height}×${form.v4l2.width}` : `${form.v4l2.width}×${form.v4l2.height}`}</span>
                                                                <span>H.264</span>
                                                                <span>{form.v4l2.fps} к/с</span>
                                                            </span>
                                                        </span>
                                                        <PurposePicker
                                                            purposes={stream.purposes}
                                                            modules={modules}
                                                            compact
                                                            hidden={['rtp']}
                                                            onToggle={(purpose: StreamPurpose) => patchStream(stream.key, togglePurpose(stream, purpose))}
                                                        />
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                        {!streamsCheck.valid && <p className="hint is-err" style={{ marginTop: 10 }}>{streamsCheck.error}</p>}
                                    </div>
                                </div>
                            </>
                        )}

                        {!local && (
                            <div className="add-block">
                                <div className="add-block-h">
                                    <span className="t">Потоки</span>
                                    <span className="count">{form.streams.length}</span>
                                    <span className="spacer" />
                                    <button
                                        className="btn btn--sm btn--acc"
                                        disabled={!canProbe}
                                        data-tip={canProbe ? undefined : 'Сначала укажите адрес, порт и устройство'}
                                        onClick={() => setAddStreamOpen(true)}
                                    >
                                        Добавить поток
                                    </button>
                                </div>
                                <div className="add-block-b">
                                    {form.streams.length === 0 ? (
                                        <div className="add-empty">
                                            <b>Потоков нет</b>
                                        </div>
                                    ) : (
                                        <div className="scards">
                                            {form.streams.map(stream => (
                                                <div className="scard" key={stream.key}>
                                                    <span className="plate"><b>{stream.substream}</b><i>суб</i></span>
                                                    <span className="who">
                                                        <span className="n">
                                                            <span className="seps">
                                                                {describe(stream).map(part => <span key={part}>{part}</span>)}
                                                            </span>
                                                        </span>
                                                        <PurposePicker
                                                            purposes={stream.purposes}
                                                            modules={modules}
                                                            compact
                                                            hidden={['rtp']}
                                                            onToggle={(purpose: StreamPurpose) =>
                                                                patchStream(stream.key, togglePurpose(stream, purpose))}
                                                        />
                                                    </span>
                                                    <Seg className="seg--xs" title="Транспорт RTSP">
                                                        <button
                                                            type="button"
                                                            className={stream.use_udp ? '' : 'is-on'}
                                                            onClick={() => patchStream(stream.key, { use_udp: false })}
                                                        >
                                                            TCP
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={stream.use_udp ? 'is-on' : ''}
                                                            onClick={() => patchStream(stream.key, { use_udp: true })}
                                                        >
                                                            UDP
                                                        </button>
                                                    </Seg>
                                                    <button
                                                        type="button"
                                                        className="del"
                                                        onClick={() => removeStream(stream.key)}
                                                        aria-label={`Удалить поток, субпоток ${stream.substream}`}
                                                    >
                                                        <Icon name="x" size={13} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
    
                                    {form.streams.length > 0 && !streamsCheck.valid && (
                                        <p className="hint is-err" style={{ marginTop: 10 }}>{streamsCheck.error}</p>
                                    )}
                                </div>
                            </div>
                        )}

                        {error && (
                            <div className="add-block-b">
                                <div className="banner is-err">
                                    <Icon name="warn" size={15} />
                                    {error}
                                </div>
                            </div>
                        )}
                    </div>

                    {hasMore && (
                        <span className="add-more" aria-hidden="true">
                            <Icon name="chev" size={14} className="ico" />
                        </span>
                    )}
                    </div>
                </div>

                <div className="modal-f">
                    <button className="btn btn--ghost" onClick={() => { void close(); }}>Отмена</button>
                    <span className="spacer" />
                    <button
                        className="btn btn--acc"
                        disabled={saving || !isValid}
                        data-tip={isValid ? undefined : streamsCheck.error}
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
                    existing={existingStreams()}
                    onPick={pickStreams}
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
