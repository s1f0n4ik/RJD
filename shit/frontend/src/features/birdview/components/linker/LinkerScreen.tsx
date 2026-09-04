import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Select } from '../../../../app/Select';
import { setSurroundStatus } from '../../../../app/surroundStatus';
import { linkerApi, LinkerError } from '../../api/linker';
import { ROTATIONS } from '../../api/linker';
import type {
    LinkerBindings,
    LinkerCamera,
    LinkerExport,
    LinkerExportDetail,
    LinkerParams,
    LinkerStatus,
    Rotation,
    ViewMode,
} from '../../api/linker';
import { SurroundPanel } from './SurroundPanel';
import type { SurroundTab } from './SurroundPanel';
import { TopPanel } from './TopPanel';
import SurroundWebRTCPlayer from '../../../../components/SurroundWebRTCPlayer';
import { wsUrl } from '../../constants';
import { useToast } from '../common/Toast';
import { ConfirmModal } from '../common/ConfirmModal';
import { PlanView } from './PlanView';
import { buildGeometry } from './plan-geometry';
import '../../../../screens/surround/linker.css';

// Экран «Отображение»: камеры назначаются нажатием на место схемы, ключи мест в интерфейс не попадают.
// Конфигурации и камеры тянутся на активацию, запись и настройки — на выбор конфигурации,
// статус опрашивается по таймеру, пока экран активен

const STATUS_POLL_MS = 5_000;
const START_POLL_MS = 1_000;
const START_TIMEOUT_MS = 20_000;

// Идентификатор по умолчанию — тот же, с которым линкер стартовал всегда
const DEFAULT_STREAM_ID = 'birdview_linker';

const EMPTY_STATUS: LinkerStatus = {
    running: false,
    streamId: null,
    exportId: null,
    streamName: '',
    fps: 0,
    rotation: 0,
    viewMode: 'top',
    width: 0,
    height: 0,
};

const DEFAULT_PARAMS: LinkerParams = {
    fps: 15,
    streamId: DEFAULT_STREAM_ID,
    streamName: '',
    rotation: 0,
    viewMode: 'top',
};

const SURROUND_TABS: Array<[SurroundTab, string]> = [
    ['stream', 'Поток'],
    ['scene', 'Сцена'],
    ['model', 'Модель'],
    ['cameras', 'Камеры'],
];

const TOP_TABS: Array<[SurroundTab, string]> = [
    ['stream', 'Поток'],
    ['scene', 'Сцена'],
    ['model', 'Модель'],
    ['images', 'Рисунки'],
];

interface LinkerScreenProps {
    active: boolean;
}

export function LinkerScreen({ active }: LinkerScreenProps) {
    const showToast = useToast();

    const [exports, setExports] = useState<LinkerExport[]>([]);
    const [cameras, setCameras] = useState<LinkerCamera[]>([]);
    const [loading, setLoading] = useState(true);

    const [selected, setSelected] = useState<LinkerExport | null>(null);
    const [detail, setDetail] = useState<LinkerExportDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const [bindings, setBindings] = useState<LinkerBindings>({});
    const [params, setParams] = useState<LinkerParams>(DEFAULT_PARAMS);

    const [status, setStatus] = useState<LinkerStatus>(EMPTY_STATUS);
    const [view, setView] = useState<'plan' | 'stream'>('plan');
    const [starting, setStarting] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<LinkerExport | null>(null);
    // Вкладка правой панели: поток / сцена / модель / камеры или рисунки
    const [panelTab, setPanelTab] = useState<SurroundTab>('stream');

    // Во время запуска общий опрос молчит: за подъёмом следит свой цикл
    const startingRef = useRef(starting);
    startingRef.current = starting;

    // fps правится черновиком: зажатие в 1..60 на каждое нажатие не даёт набрать «15»
    const [fpsDraft, setFpsDraft] = useState(String(DEFAULT_PARAMS.fps));

    useEffect(() => {
        setFpsDraft(String(params.fps));
    }, [params.fps]);

    // У режимов разные наборы вкладок: чужая закрывается на «Поток»
    useEffect(() => {
        if (params.viewMode === 'top' && panelTab === 'cameras') setPanelTab('stream');
        if (params.viewMode === 'surround' && panelTab === 'images') setPanelTab('stream');
    }, [params.viewMode, panelTab]);

    const commitFps = () => {
        const parsed = Number(fpsDraft);
        if (!Number.isFinite(parsed)) {
            setFpsDraft(String(params.fps));
            return;
        }
        const clamped = Math.min(60, Math.max(1, Math.round(parsed)));
        setParams(p => ({ ...p, fps: clamped }));
        setFpsDraft(String(clamped));
    };

    const toastError = useCallback(
        (title: string, e: unknown) => {
            showToast(title, e instanceof Error ? e.message : String(e), 'err');
        },
        [showToast],
    );

    const refreshExports = useCallback(async () => {
        const list = await linkerApi.getExports();
        setExports(list);
        return list;
    }, []);

    useEffect(() => {
        if (!active) return;
        let alive = true;

        setLoading(true);
        Promise.all([linkerApi.getExports(), linkerApi.getCameras(), linkerApi.getStatus()])
            .then(([exps, cams, st]) => {
                if (!alive) return;
                setExports(exps);
                setCameras(cams);
                setStatus(st);
            })
            .catch((e: unknown) => {
                if (alive) toastError('Не удалось загрузить', e);
            })
            .finally(() => {
                if (alive) setLoading(false);
            });

        return () => {
            alive = false;
        };
    }, [active, toastError]);

    useEffect(() => {
        if (!active) return;
        const id = window.setInterval(() => {
            if (startingRef.current) return;
            linkerApi.getStatus().then(setStatus).catch(() => {});
        }, STATUS_POLL_MS);
        return () => window.clearInterval(id);
    }, [active]);

    // Точка у «Отображения» в рельсе: вывод в эфире
    useEffect(() => {
        setSurroundStatus({ live: status.running });
        return () => setSurroundStatus({ live: false });
    }, [status.running]);

    // Возврат к схеме: линкер остановлен либо выбрана конфигурация, чей вывод не идёт
    useEffect(() => {
        if (view !== 'stream' || starting) return;

        const watchable = status.running && status.exportId === selected?.id && status.streamId;
        if (!watchable) setView('plan');
    }, [status.running, status.exportId, status.streamId, selected?.id, view, starting]);

    const selectExport = async (exp: LinkerExport) => {
        setSelected(exp);
        setDetail(null);
        setDetailLoading(true);
        try {
            const [full, state] = await Promise.all([
                linkerApi.getExport(exp.id),
                linkerApi.getStateFor(exp.id),
            ]);
            setDetail(full);

            // Сохранённые привязки главнее целиком; без записи в состоянии — префилл из пресета
            let bindings = state.bindings;
            if (Object.keys(bindings).length === 0) {
                const prefill: LinkerBindings = {};
                for (const p of full.places) {
                    if (!p.cameraId) continue;
                    if (!cameras.some(c => c.id === p.cameraId)) continue;
                    if (Object.values(prefill).includes(p.cameraId)) continue;
                    prefill[p.key] = p.cameraId;
                }
                bindings = prefill;
            }
            setBindings(bindings);
            setParams({
                fps: state.params.fps ?? DEFAULT_PARAMS.fps,
                streamId: state.params.streamId ?? DEFAULT_STREAM_ID,
                streamName: state.params.streamName ?? full.name,
                // Сервер сам сообщает угол, с которым запустит конфигурацию
                rotation: state.params.rotation ?? full.rotation,
                viewMode: state.params.viewMode ?? 'top',
            });
        } catch (e) {
            toastError('Не удалось открыть конфигурацию', e);
            setSelected(null);
        } finally {
            setDetailLoading(false);
        }
    };

    const assign = (key: string, cameraId: string | null) => {
        setBindings(prev => {
            const next = { ...prev };
            // Камера стоит только на одном месте: снимаем её с прежнего
            if (cameraId) {
                for (const k of Object.keys(next)) {
                    if (next[k] === cameraId) delete next[k];
                }
                next[key] = cameraId;
            } else {
                delete next[key];
            }
            return next;
        });
    };

    // POST /linker/start не возвращает stream_id: ждём его появления через статус
    const waitForStream = async (): Promise<LinkerStatus | null> => {
        const deadline = Date.now() + START_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                const st = await linkerApi.getStatus();
                if (st.running && st.streamId) return st;
            } catch {
                // Сеть моргнула — пробуем дальше до таймаута
            }
            await new Promise(r => setTimeout(r, START_POLL_MS));
        }
        return null;
    };

    const start = async () => {
        if (!selected) return;

        setStarting(true);
        try {
            await linkerApi.saveState(selected.id, bindings, params);
            await linkerApi.start();

            const ready = await waitForStream();
            if (!ready) throw new Error('Стрим не поднялся за 20 секунд');

            setStatus(ready);
            setView('stream');
            showToast('Запущено', params.streamName || selected.name || selected.id, 'ok');
        } catch (e) {
            toastError('Не запустилось', e);
        } finally {
            setStarting(false);
        }
    };

    const stop = async () => {
        try {
            await linkerApi.stop();
        } catch (e) {
            toastError('Не остановилось', e);
        }
        setView('plan');
        linkerApi.getStatus().then(setStatus).catch(() => {});
    };

    const remove = async () => {
        const target = pendingDelete;
        if (!target) return;
        setPendingDelete(null);

        try {
            await linkerApi.deleteExport(target.id);
            const list = await refreshExports();

            if (selected?.id === target.id) {
                setSelected(null);
                setDetail(null);
                setBindings({});
                setParams(DEFAULT_PARAMS);
            }

            showToast('Удалено', `${target.name ?? target.id} · осталось ${list.length}`, 'ok');
        } catch (e) {
            // Отказ удалить работающую конфигурацию — не сбой, а состояние
            const conflict = e instanceof LinkerError && e.status === 409;
            showToast(
                conflict ? 'Конфигурация в эфире' : 'Не удалось удалить',
                conflict ? 'Сначала остановите вывод' : e instanceof Error ? e.message : String(e),
                'err',
            );
        }
    };

    // Поворот уходит своей ручкой: сервер сам пересобирает живой вывод под новый размер кадра
    const applyRotation = async (rotation: Rotation) => {
        if (!selected) return;
        const previous = params.rotation;
        setParams(p => ({ ...p, rotation }));

        try {
            await linkerApi.setRotation(rotation, selected.id);
            const live = status.running && status.exportId === selected.id;
            showToast(
                'Поворот применён',
                live ? `${rotation}° · вывод перезапущен` : `${rotation}°`,
                'ok',
            );
            if (live) linkerApi.getStatus().then(setStatus).catch(() => {});
        } catch (e) {
            setParams(p => ({ ...p, rotation: previous }));
            toastError('Поворот не применён', e);
        }
    };

    // Смена режима своей ручкой: сервер пересобирает живой вывод, подъём ждём как при запуске
    const applyViewMode = async (mode: ViewMode) => {
        if (!selected || params.viewMode === mode) return;
        const previous = params.viewMode;
        setParams(p => ({ ...p, viewMode: mode }));

        const live = status.running && status.exportId === selected.id;
        try {
            if (live) setStarting(true);
            await linkerApi.setViewMode(mode, selected.id);
            if (live) {
                const ready = await waitForStream();
                if (!ready) throw new Error('Вывод не поднялся после смены режима');
                setStatus(ready);
            }
            showToast(
                'Режим применён',
                (mode === 'surround' ? 'Объёмный вид' : 'Вид сверху') +
                    (live ? ' · вывод перезапущен' : ''),
                'ok',
            );
        } catch (e) {
            setParams(p => ({ ...p, viewMode: previous }));
            toastError('Режим не применён', e);
        } finally {
            if (live) setStarting(false);
        }
    };

    // Смена разрешения: стоп, запись в остановленную конфигурацию, старт, ожидание подъёма
    const applyResolution = async (res: { width: number; height: number }): Promise<boolean> => {
        if (!selected) return false;
        setStarting(true);
        try {
            await linkerApi.stop();
            await linkerApi.postSurround({ resolution: res }, selected.id);
            await linkerApi.start();
            const ready = await waitForStream();
            if (!ready) throw new Error('Вывод не поднялся после смены разрешения');
            setStatus(ready);
            showToast('Разрешение применено', `${res.width}×${res.height} · вывод перезапущен`, 'ok');
            return true;
        } catch (e) {
            toastError('Разрешение не применено', e);
            linkerApi.getStatus().then(setStatus).catch(() => {});
            return false;
        } finally {
            setStarting(false);
        }
    };

    // Разрешение top-кадра: живой вывод — стоп, запись, старт; остановленный — только запись
    const applyTopResolution = async (res: { width: number; height: number }): Promise<boolean> => {
        if (!selected) return false;
        const live = status.running && status.exportId === selected.id;
        if (!live) {
            try {
                await linkerApi.postTop({ resolution: res }, selected.id);
                showToast('Разрешение сохранено', `${res.width}×${res.height}`, 'ok');
                return true;
            } catch (e) {
                toastError('Разрешение не применено', e);
                return false;
            }
        }
        setStarting(true);
        try {
            await linkerApi.stop();
            await linkerApi.postTop({ resolution: res }, selected.id);
            await linkerApi.start();
            const ready = await waitForStream();
            if (!ready) throw new Error('Вывод не поднялся после смены разрешения');
            setStatus(ready);
            showToast('Разрешение применено', `${res.width}×${res.height} · вывод перезапущен`, 'ok');
            return true;
        } catch (e) {
            toastError('Разрешение не применено', e);
            linkerApi.getStatus().then(setStatus).catch(() => {});
            return false;
        } finally {
            setStarting(false);
        }
    };

    // Пересчёт и смена версии перезапускают живой вывод: статус подтягивается сразу
    const refreshStatus = useCallback(() => {
        linkerApi.getStatus().then(setStatus).catch(() => {});
    }, []);

    const geometry = useMemo(() => (detail ? buildGeometry(detail) : null), [detail]);

    const placeNames = useMemo(() => {
        const names: Record<string, string> = {};
        for (const p of detail?.places ?? []) names[p.key] = p.name;
        return names;
    }, [detail]);

    const places = detail?.places.length ?? 0;
    const assigned = detail ? detail.places.filter(p => bindings[p.key]).length : 0;
    const complete = places > 0 && assigned === places;

    const isLive = status.running && status.exportId === selected?.id;
    // Смотреть можно только конфигурацию в эфире: у остальных вкладка вела бы на чужую картинку
    const canWatch = isLive && Boolean(status.streamId);

    const exportOptions = exports.map(exp => ({
        value: exp.id,
        label: exp.name || exp.id,
        // Без ректа габарита и картинок мир не отмасштабировать
        hint: exp.valid ? `${exp.cameras?.length ?? 0} мест · ${exp.id}` : 'нет габарита',
        disabled: !exp.valid,
    }));

    const tabs = params.viewMode === 'surround' ? SURROUND_TABS : TOP_TABS;
    const fieldsLocked = !selected || isLive;

    return (
        <div className={`sv sv-link${active ? '' : ' is-hidden'}`}>
            <div className="sv-main">
                <div className="toolbar">
                    <div className="tf">
                        <Select
                            value={selected?.id ?? ''}
                            options={exportOptions}
                            placeholder={loading ? 'Загрузка…' : 'Конфигурация'}
                            emptyText="Нет конфигураций"
                            disabled={loading || starting}
                            onChange={id => {
                                const exp = exports.find(e => e.id === id);
                                if (exp && exp.id !== selected?.id) void selectExport(exp);
                            }}
                        />
                    </div>
                    <button
                        type="button"
                        className="icon-btn"
                        data-tip="Удалить конфигурацию"
                        disabled={!selected || isLive || starting}
                        aria-label="Удалить конфигурацию"
                        onClick={() => selected && setPendingDelete(selected)}
                    >
                        <Icon name="trash" size={14} />
                    </button>
                    <span className="tbar-sep" />

                    <span className={`pill has-tip${isLive ? ' ok' : status.running ? ' warn' : ''}`}>
                        <span className="dot" />
                        {isLive ? 'в эфире' : status.running ? 'в эфире · другая конфигурация' : 'остановлен'}
                        <div className="tipbox" style={{ right: 'auto', left: 0 }}>
                            <div className="kv"><span className="k">Поток</span><span className="v">{status.streamId ?? '—'}</span></div>
                            <div className="kv"><span className="k">Режим</span><span className="v">{status.viewMode === 'surround' ? 'объём' : 'сверху'}</span></div>
                            <div className="kv"><span className="k">Кадр</span><span className="v">{status.width && status.height ? `${status.width}×${status.height} · ${status.fps} fps` : '—'}</span></div>
                            <div className="kv"><span className="k">Конфигурация</span><span className="v">{status.exportId ?? '—'}</span></div>
                            <div className="kv"><span className="k">Камер</span><span className="v">{places ? `${assigned} из ${places}` : '—'}</span></div>
                        </div>
                    </span>
                    <span className={`pill${complete ? ' ok' : ''}`}>
                        <span className="dot acc" />
                        {places ? `назначено ${assigned} из ${places}` : 'назначено —'}
                    </span>
                    {geometry && geometry.missing.length > 0 && (
                        <span className="pill warn" title={geometry.missing.join(', ')}>
                            <span className="dot warn" />
                            без места: {geometry.missing.length}
                        </span>
                    )}

                    <div className="pills">
                        <div className="seg" role="group" aria-label="Что показывать">
                            <button
                                type="button"
                                className={view === 'plan' ? 'is-on' : ''}
                                onClick={() => setView('plan')}
                            >
                                Схема
                            </button>
                            <button
                                type="button"
                                className={view === 'stream' ? 'is-on' : ''}
                                disabled={!canWatch}
                                onClick={() => canWatch && setView('stream')}
                            >
                                Поток
                            </button>
                        </div>
                    </div>
                </div>

                <div className="canvas-wrap">
                    {view === 'stream' && status.streamId ? (
                        // Без кнопок: режимом и орбитой управляет панель параметров
                        <div className="stream">
                            <SurroundWebRTCPlayer
                                key={`linker-${status.streamId}-${status.viewMode}`}
                                cameraId={status.streamId}
                                signalingUrl={wsUrl(`/signaling/client/${status.streamId}`)}
                                background="transparent"
                                onError={e => toastError('Плеер', e)}
                            />
                        </div>
                    ) : (
                        <div className="plan">
                            {!selected ? (
                                <div className="empty">
                                    <Icon name="empty" />
                                    <b>Конфигурация не выбрана</b>
                                </div>
                            ) : detailLoading ? (
                                <div className="empty">
                                    <span className="spin" />
                                </div>
                            ) : geometry && geometry.tiles.length > 0 ? (
                                <PlanView
                                    geometry={geometry}
                                    bindings={bindings}
                                    cameras={cameras}
                                    locked={isLive || starting}
                                    onAssign={assign}
                                />
                            ) : (
                                <div className="empty">
                                    <Icon name="warn" />
                                    <b>Нет мест камер</b>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <aside className="mod-side">
                <div className="sv-tabs">
                    <div className="seg" role="tablist" aria-label="Разделы параметров">
                        {tabs.map(([key, title]) => (
                            <button
                                key={key}
                                type="button"
                                role="tab"
                                aria-selected={panelTab === key}
                                className={panelTab === key ? 'is-on' : ''}
                                onClick={() => setPanelTab(key)}
                            >
                                {title}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="blk-b pad">
                    {panelTab === 'stream' && (
                        <>
                            <label className="tf">
                                <span className="tf-cap">Название потока</span>
                                <input
                                    className="tf-in"
                                    type="text"
                                    value={params.streamName}
                                    disabled={fieldsLocked}
                                    onChange={e => setParams(p => ({ ...p, streamName: e.target.value }))}
                                    onBlur={e => setParams(p => ({ ...p, streamName: e.target.value.trim() }))}
                                />
                            </label>
                            <div className="tf-row">
                                <label className="tf">
                                    <span className="tf-cap">ID потока</span>
                                    <input
                                        className="tf-in"
                                        type="text"
                                        value={params.streamId}
                                        disabled={fieldsLocked}
                                        onChange={e => setParams(p => ({ ...p, streamId: e.target.value }))}
                                        onBlur={e =>
                                            setParams(p => ({
                                                ...p,
                                                streamId: e.target.value.trim() || DEFAULT_STREAM_ID,
                                            }))
                                        }
                                    />
                                </label>
                                <label className="tf" style={{ flex: '0 0 72px' }}>
                                    <span className="tf-cap">FPS</span>
                                    <input
                                        className="tf-in"
                                        type="number"
                                        min={1}
                                        max={60}
                                        value={fpsDraft}
                                        disabled={fieldsLocked}
                                        onChange={e => setFpsDraft(e.target.value)}
                                        onBlur={() => commitFps()}
                                        onWheel={e => e.currentTarget.blur()}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') commitFps();
                                        }}
                                    />
                                </label>
                            </div>

                            <div className="tf">
                                <span className="tf-cap">Режим вывода</span>
                                <div className="seg" role="group" aria-label="Режим вывода">
                                    <button
                                        type="button"
                                        className={params.viewMode === 'top' ? 'is-on' : ''}
                                        disabled={!selected || starting}
                                        onClick={() => applyViewMode('top')}
                                    >
                                        Сверху
                                    </button>
                                    <button
                                        type="button"
                                        className={params.viewMode === 'surround' ? 'is-on' : ''}
                                        disabled={!selected || starting}
                                        onClick={() => applyViewMode('surround')}
                                    >
                                        Объём
                                    </button>
                                </div>
                            </div>

                            {/* Поворот — свойство плоской сшивки, в объёме его нет */}
                            {params.viewMode === 'top' && (
                                <div className="tf">
                                    <span className="tf-cap">Поворот</span>
                                    <div className="rot" role="group" aria-label="Поворот вывода">
                                        {ROTATIONS.map(deg => (
                                            <button
                                                key={deg}
                                                type="button"
                                                className={`chip${params.rotation === deg ? ' is-on' : ''}`}
                                                disabled={!selected}
                                                onClick={() => applyRotation(deg)}
                                            >
                                                {deg}°
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {params.viewMode === 'surround' && selected ? (
                        <SurroundPanel
                            live={isLive && status.viewMode === 'surround'}
                            exportId={selected.id}
                            tab={panelTab}
                            placeNames={placeNames}
                            onError={toastError}
                            onApplyResolution={applyResolution}
                        />
                    ) : params.viewMode === 'top' && selected ? (
                        <TopPanel
                            live={isLive && status.viewMode === 'top'}
                            exportId={selected.id}
                            tab={panelTab}
                            onError={toastError}
                            onApplyResolution={applyTopResolution}
                            onOutputRestarted={refreshStatus}
                        />
                    ) : (
                        panelTab !== 'stream' && (
                            <div className="empty">Конфигурация не выбрана</div>
                        )
                    )}
                </div>

                <div className="sv-foot">
                    {status.running ? (
                        <button type="button" className="btn btn--err btn--wide" onClick={stop}>
                            <Icon name="pause" />
                            Остановить вывод
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="btn btn--acc btn--wide"
                            disabled={!complete || starting}
                            onClick={start}
                        >
                            {starting ? <span className="spin sm" /> : <Icon name="play" />}
                            {starting ? 'Запуск…' : 'Запустить вывод'}
                        </button>
                    )}
                </div>
            </aside>

            {pendingDelete && (
                <ConfirmModal
                    title="Удалить конфигурацию"
                    confirmText="Удалить"
                    danger
                    message={`${pendingDelete.name || pendingDelete.id} · ${pendingDelete.cameras?.length ?? 0} мест`}
                    onCancel={() => setPendingDelete(null)}
                    onConfirm={remove}
                />
            )}
        </div>
    );
}
