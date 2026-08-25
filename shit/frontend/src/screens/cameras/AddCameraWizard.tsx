import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { Select } from '../../app/Select';
import { api } from '../../services/api';
import { getDevices, mcPath, signalingWsUrl } from '../../services/devices';
import type { StreamPurpose } from '../../types';
import { AddStreamModal, type FoundStream } from './AddStreamModal';
import { PurposePicker, useDeviceModules } from './CameraFields';
import { LivePreview } from './LivePreview';
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
    togglePurpose,
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

/** Единственный поток временной камеры предпросмотра. */
const PREVIEW_STREAM = 'stream_1';

/*
    Между ответом на POST и появлением камеры в сигналинге проходит проба
    RTSP — секунда-полторы. Клиент, подключившийся в эту дыру, получает отказ,
    поэтому плеер ждёт, пока поток действительно пойдёт.
*/
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

    /*
        Следим и за областью, и за её блоками: ResizeObserver на самом
        контейнере не сработает, когда меняется только высота содержимого —
        а она меняется при каждом добавленном потоке.
    */
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

    // Опрашивать нечего, пока не известно куда идти и с какого устройства
    const canProbe = ipCheck.valid && portCheck.valid && !!form.device_id;
    const isValid = nameCheck.valid && ipCheck.valid && portCheck.valid && streamsCheck.valid && !!form.device_id;

    const viewStream = form.streams.find(s => s.purposes.includes('view')) ?? null;

    // ── Предпросмотр ──────────────────────────────────────────────────────
    /*
        Сессия WebRTC адресуется по камере, а её в мастере ещё нет — поэтому
        на время просмотра поднимается временная. Префикс __probe_ media-center
        в конфигурацию не пишет, так что переживёт её только процесс.
    */
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
            /* временная камера, молча */
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
                /* камера ещё поднимается, пробуем снова */
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
        payload.display_name = `Проверка ${form.ip_adress}`;
        payload.description = 'Временная камера предпросмотра';

        try {
            await api.createCamera(payload, device);

            // Пока шёл запрос, могли нажать «Остановить» или сменить подключение —
            // тогда камера уже никому не нужна, и её надо убрать за собой
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
        form.ip_adress, form.port, form.user, form.password, form.production,
        form.device_id, viewStream?.substream ?? 0,
    ].join('|');

    useEffect(() => {
        // Гасим только при настоящей смене того, из чего собрана ссылка.
        // Раньше условие смотрело на сам факт наличия сессии, и любой лишний
        // прогон эффекта убивал только что созданную камеру
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
    const pickStream = (found: FoundStream) => {
        setAddStreamOpen(false);
        setProbed(prev => ({ ...prev, [found.substream]: found }));
        setForm(prev => ({
            ...prev,
            streams: [...prev.streams, makeStream(nextStreamKey(prev.streams), found.substream, ['view'])],
        }));
    };

    const removeStream = (key: string) =>
        setForm(prev => ({ ...prev, streams: prev.streams.filter(s => s.key !== key) }));

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

    const describe = (stream: StreamForm): string => {
        const info = probed[stream.substream];
        if (!info || !info.width) return 'параметры неизвестны';
        return [
            `${info.width}×${info.height}`,
            info.codec ? info.codec.toUpperCase() : null,
            info.fps ? `${info.fps} к/с` : null,
        ].filter(Boolean).join(' · ');
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
                                caption={viewStream ? `субпоток ${viewStream.substream}` : undefined}
                                style={{ flex: 'none', width: '100%' }}
                            />
                        ) : (
                            <div className="cam-preview" style={{ flex: 'none', width: '100%' }}>
                                <div className="state">
                                    {previewBusy
                                        ? <><span className="spin" />поднимаем поток на устройстве…</>
                                        : previewError
                                            ? previewError
                                            : viewStream
                                                ? `Субпоток ${viewStream.substream} · нажмите «Показать превью»`
                                                : 'Появится, когда у камеры будет поток с назначением «Просмотр»'}
                                </div>
                            </div>
                        )}

                        <button
                            className="btn"
                            style={{ width: '100%', justifyContent: 'center' }}
                            disabled={!viewStream || previewBusy || !form.device_id}
                            onClick={() => (previewName ? void stopPreview('остановлено оператором') : void startPreview())}
                        >
                            {previewBusy
                                ? 'Поднимаем поток…'
                                : previewName ? 'Остановить превью' : 'Показать превью'}
                        </button>

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
                            Превью открывает настоящую сессию к камере и заводит временную запись
                            на устройстве — она убирается, как только просмотр остановлен.
                        </p>
                    </aside>

                    <div className="add-pane">
                    <div className="add-main" ref={mainRef} onScroll={syncMore}>
                        <div className="add-block">
                            <div className="add-block-h"><span className="t">Подключение</span></div>
                            <div className="add-block-b">
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
                                <div className="add-row add-row--meta" style={{ marginBottom: 0 }}>
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
                                {!nameCheck.valid && <p className="hint is-err" style={{ marginTop: 10 }}>{nameCheck.error}</p>}
                                {!ipCheck.valid && form.ip_adress !== '' && (
                                    <p className="hint is-err" style={{ marginTop: 10 }}>{ipCheck.error}</p>
                                )}
                                {!portCheck.valid && <p className="hint is-err" style={{ marginTop: 10 }}>{portCheck.error}</p>}
                            </div>
                        </div>

                        <div className="add-block">
                            <div className="add-block-h">
                                <span className="t">Потоки</span>
                                <span className="count">{form.streams.length}</span>
                                <span className="spacer" />
                                <button
                                    className="btn btn--sm btn--acc"
                                    disabled={!canProbe}
                                    title={canProbe ? undefined : 'Сначала укажите адрес, порт и устройство'}
                                    onClick={() => setAddStreamOpen(true)}
                                >
                                    Добавить поток
                                </button>
                            </div>
                            <div className="add-block-b">
                                {form.streams.length === 0 ? (
                                    <div className="add-empty">
                                        <b>Потоков нет</b>
                                        Нажмите «Добавить поток» — media-center опросит камеру
                                        и покажет, какие субпотоки она отдаёт
                                    </div>
                                ) : (
                                    <div className="scards">
                                        {form.streams.map(stream => (
                                            <div className="scard" key={stream.key}>
                                                <span className="plate"><b>{stream.substream}</b><i>суб</i></span>
                                                <span className="who">
                                                    <span className="n">{describe(stream)}</span>
                                                    <PurposePicker
                                                        purposes={stream.purposes}
                                                        modules={modules}
                                                        compact
                                                        onToggle={(purpose: StreamPurpose) =>
                                                            patchStream(stream.key, togglePurpose(stream, purpose))}
                                                    />
                                                </span>
                                                <span className="seg seg--xs" title="Транспорт RTSP">
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
                                                </span>
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
