import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * Экран «Вывод» (линкер). Порт page-3, переписанный на схему.
 *
 * Камеры назначаются не списком ключей, а нажатием на место схемы: места
 * рисуются прямоугольниками из самой конфигурации, поэтому перепутанная
 * камера видна сразу. Ключи вроде left_front в интерфейс не попадают.
 *
 * Данные тянутся по требованию: конфигурации и камеры — на активацию экрана,
 * запись конфигурации и её настройки — на клик по ней. Отдельно от них статус
 * опрашивается по таймеру, пока экран активен: иначе состояние врёт, если
 * линкер остановили снаружи или он упал.
 */

const STATUS_POLL_MS = 5_000;
const START_POLL_MS = 1_000;
const START_TIMEOUT_MS = 20_000;

/** Идентификатор по умолчанию — тот же, с которым линкер стартовал всегда. */
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
    // Схема на узком канвасе тесная — колонку со списком можно убрать
    const [asideOpen, setAsideOpen] = useState(true);
    // Вкладка правой колонки: поток / сцена / модель / камеры
    const [panelTab, setPanelTab] = useState<SurroundTab>('stream');

    // Во время запуска общий опрос молчит: за подъёмом следит свой цикл
    const startingRef = useRef(starting);
    startingRef.current = starting;

    // fps правится черновиком: зажатие в 1..60 на каждое нажатие клавиши
    // не даёт набрать «15», превращая первую единицу в готовое значение
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

    /*
        Возврат к схеме, когда смотреть больше нечего.

        Два случая: линкер остановлен вовсе, либо оператор выбрал в списке
        другую конфигурацию — её вывод не запущен, и показывать в плеере чужую
        картинку нельзя. Плеер размонтируется, WebRTC-сессия рвётся, а сам
        вывод продолжает работать: его смотрят по id стрима и другие.
    */
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

            /*
                Сохранённые привязки главнее целиком: явно снятая камера не
                должна воскресать. А вот конфигурацию без своей записи в
                состоянии префиллим привязками из пресета, снятыми при
                расчёте LUT — только доступными камерами и без дублей.
            */
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

    /**
     * POST /linker/start не возвращает stream_id, а сам линкер присваивает его
     * уже после возврата из async_start. Поэтому ждём появления через статус.
     */
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

    /**
     * Поворот уходит своей ручкой, а не в общем сохранении: он свойство
     * картинки, и сервер сам пересобирает живой вывод — при 90 и 270 размер
     * кадра другой, а пайплайн создаётся под конкретный.
     */
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

    /**
     * Смена режима своей ручкой, как поворот: сервер сам пересобирает живой
     * вывод — у режимов разный размер кадра и пайплайн. После пересборки
     * ждём подъёма стрима той же механикой, что и при запуске.
     */
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

    /**
     * Смена разрешения — как выключить и включить вывод, только одной кнопкой:
     * стоп, запись в остановленную конфигурацию, старт, ожидание подъёма.
     * Эта связка уже отлажена ручными кнопками, ей и пользуемся.
     */
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

    /**
     * Разрешение top-кадра тем же паттерном, что у surround: живой вывод —
     * стоп, запись, старт; остановленный — только запись, рестарт не нужен.
     */
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

    // Пересчёт и смена версии перезапускают живой вывод на сервере —
    // статус подтягивается сразу, не дожидаясь общего опроса
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
    // Смотреть можно только ту конфигурацию, что сейчас в эфире: у остальных
    // вкладка вела бы на чужую картинку и путала
    const canWatch = isLive && Boolean(status.streamId);

    return (
        <main
            className={
                'main-layout linker-layout' +
                (asideOpen ? '' : ' aside-hidden') +
                (active ? '' : ' hidden')
            }
        >
            <button
                className={`linker-aside-tab${asideOpen ? ' open' : ''}`}
                onClick={() => setAsideOpen(o => !o)}
                title={asideOpen ? 'Скрыть список конфигураций' : 'Показать список конфигураций'}
            >
                <span className="proj-tab-icon">{asideOpen ? '‹' : '›'}</span>
                <span className="proj-tab-label">Конфигурации</span>
            </button>

            <aside className="sidebar linker-aside">
                <div className="col-title">Конфигурации</div>

                {loading ? (
                    <div className="linker-empty">Загрузка...</div>
                ) : exports.length === 0 ? (
                    <div className="linker-empty">
                        Нет конфигураций. Посчитайте LUT на экране сборки.
                    </div>
                ) : (
                    <div className="linker-cfg-list">
                        {exports.map(exp => {
                            const live = status.running && status.exportId === exp.id;
                            // Без ректа габарита и картинок мир не отмасштабировать
                            const broken = !exp.valid;
                            return (
                                <div
                                    key={exp.id}
                                    className={`linker-cfg${selected?.id === exp.id ? ' on' : ''}${broken ? ' broken' : ''}`}
                                    title={broken ? 'Нет габарита и рисунков — задайте габарит в конфигураторе' : ''}
                                    onClick={() => {
                                        if (starting) return;
                                        if (broken) {
                                            showToast(
                                                'Конфигурация ошибочна',
                                                'Нет ни габарита, ни рисунка. Задайте габарит в конфигураторе',
                                                'err',
                                            );
                                            return;
                                        }
                                        void selectExport(exp);
                                    }}
                                >
                                    <span className="linker-cfg-dot" />
                                    <span className="linker-cfg-body">
                                        <span className="linker-cfg-name">{exp.name || exp.id}</span>
                                        <span className="linker-cfg-meta">
                                            {(exp.cameras?.length ?? 0)} мест · {exp.id}
                                        </span>
                                    </span>
                                    {broken && <span className="linker-cfg-broken">нет габарита</span>}
                                    {live && <span className="linker-cfg-live">LIVE</span>}
                                    <button
                                        type="button"
                                        className="linker-cfg-del"
                                        disabled={live}
                                        title={live ? 'Сначала остановите вывод' : 'Удалить конфигурацию'}
                                        aria-label={`Удалить ${exp.name || exp.id}`}
                                        onClick={e => {
                                            e.stopPropagation();
                                            if (!live) setPendingDelete(exp);
                                        }}
                                    >
                                        ✕
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="col-title" style={{ marginTop: 18 }}>Состояние</div>
                <div className="linker-kv">
                    <span className="linker-kv-k">Вывод</span>
                    <span className={`linker-kv-v${status.running ? ' ok' : ''}`}>
                        {status.running ? 'в эфире' : 'остановлен'}
                    </span>
                </div>
                <div className="linker-kv">
                    <span className="linker-kv-k">Стрим</span>
                    <span className="linker-kv-v">{status.streamId ?? '—'}</span>
                </div>
                <div className="linker-kv">
                    <span className="linker-kv-k">Режим</span>
                    <span className="linker-kv-v">
                        {status.viewMode === 'surround' ? 'объём' : 'сверху'}
                    </span>
                </div>
                <div className="linker-kv">
                    <span className="linker-kv-k">Камер</span>
                    <span className="linker-kv-v">{assigned} / {places || '—'}</span>
                </div>
                {/* Кадр шире канваса: стороны округляются под кодек */}
                <div className="linker-kv">
                    <span className="linker-kv-k">Кадр</span>
                    <span className="linker-kv-v">
                        {status.width && status.height ? `${status.width} × ${status.height}` : '—'}
                    </span>
                </div>
            </aside>

            <section className="linker-stage-pane">
                <div className="linker-stage-head">
                    <span className="linker-progress">
                        <span className="linker-progress-k">Назначено</span>
                        <span className="linker-progress-n">
                            {places ? `${assigned} из ${places}` : '—'}
                        </span>
                        <span className="linker-progress-bar">
                            <span
                                className="linker-progress-fill"
                                style={{ width: places ? `${(assigned / places) * 100}%` : '0%' }}
                            />
                        </span>
                    </span>

                    <span className="view-seg" role="group" aria-label="Что показывать">
                        <button
                            type="button"
                            aria-pressed={view === 'plan'}
                            onClick={() => setView('plan')}
                        >
                            Схема
                        </button>
                        <button
                            type="button"
                            aria-pressed={view === 'stream'}
                            disabled={!canWatch}
                            title={
                                canWatch
                                    ? ''
                                    : status.running
                                      ? 'В эфире другая конфигурация'
                                      : 'Поток не запущен'
                            }
                            onClick={() => canWatch && setView('stream')}
                        >
                            Стрим
                        </button>
                    </span>
                </div>

                <div className="linker-stage">
                    {view === 'stream' && status.streamId ? (
                        // Плееру нужна обёртка заданного размера: сам он задаёт
                        // только высоту, и без ширины схлопывается по содержимому —
                        // отсюда чёрная полоса по размеру индикатора загрузки
                        // Без кнопок: режимом и орбитой здесь управляет форма параметров
                        <div className="linker-player">
                            <SurroundWebRTCPlayer
                                key={`linker-${status.streamId}-${status.viewMode}`}
                                cameraId={status.streamId}
                                signalingUrl={wsUrl(`/signaling/client/${status.streamId}`)}
                                background="transparent"
                                onError={e => toastError('Плеер', e)}
                            />
                        </div>
                    ) : !selected ? (
                        <div className="no-signal">
                            <div className="no-signal-icon">◫</div>
                            <div className="no-signal-text">Конфигурация не выбрана</div>
                            <div className="no-signal-sub">Выберите её в списке слева</div>
                        </div>
                    ) : detailLoading ? (
                        <div className="no-signal">
                            <div className="no-signal-icon">◌</div>
                            <div className="no-signal-text">Загрузка схемы</div>
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
                        <div className="no-signal">
                            <div className="no-signal-icon">⊘</div>
                            <div className="no-signal-text">Схему не построить</div>
                            <div className="no-signal-sub">
                                В конфигурации нет мест камер. Пересчитайте LUT на экране сборки
                            </div>
                        </div>
                    )}
                </div>

                {geometry && geometry.missing.length > 0 && (
                    <div className="linker-warn">
                        Без места на канвасе: {geometry.missing.join(', ')}. Эти камеры на схеме
                        не показаны — пересчитайте конфигурацию
                    </div>
                )}
            </section>

            <aside className="sidebar linker-aside">
                <div className="col-title">Параметры вывода</div>

                {/* У плоской сшивки поз камер нет — вкладки «Камеры» тоже */}
                <div className="srd-tabs" role="tablist" aria-label="Разделы параметров">
                    {(params.viewMode === 'surround'
                        ? ([
                            ['stream', 'Поток'],
                            ['scene', 'Сцена'],
                            ['model', 'Модель'],
                            ['cameras', 'Камеры'],
                        ] as Array<[SurroundTab, string]>)
                        : ([
                            ['stream', 'Поток'],
                            ['scene', 'Сцена'],
                            ['model', 'Модель'],
                            ['images', 'Рисунки'],
                        ] as Array<[SurroundTab, string]>)
                    ).map(([key, title]) => (
                        <button
                            key={key}
                            type="button"
                            aria-pressed={panelTab === key}
                            onClick={() => setPanelTab(key)}
                        >
                            {title}
                        </button>
                    ))}
                </div>

                {panelTab === 'stream' && (
                    <>
                        <div className="linker-lock-wrap">
                        <div className="field-group">
                            <label className="field-label">Название стрима</label>
                            <input
                                className="field-input"
                                type="text"
                                value={params.streamName}
                                disabled={!selected || isLive}
                                onChange={e => setParams(p => ({ ...p, streamName: e.target.value }))}
                                onBlur={e => setParams(p => ({ ...p, streamName: e.target.value.trim() }))}
                            />
                        </div>

                        <div className="field-group">
                            <label className="field-label">ID стрима</label>
                            <input
                                className="field-input"
                                type="text"
                                value={params.streamId}
                                disabled={!selected || isLive}
                                onChange={e => setParams(p => ({ ...p, streamId: e.target.value }))}
                                onBlur={e =>
                                    setParams(p => ({
                                        ...p,
                                        streamId: e.target.value.trim() || DEFAULT_STREAM_ID,
                                    }))
                                }
                            />
                        </div>

                        <div className="field-group">
                            <label className="field-label">Кадров в секунду</label>
                            <input
                                className="field-input"
                                type="number"
                                min={1}
                                max={60}
                                value={fpsDraft}
                                disabled={!selected || isLive}
                                onChange={e => setFpsDraft(e.target.value)}
                                onBlur={() => commitFps()}
                                onWheel={e => e.currentTarget.blur()}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') commitFps();
                                }}
                            />
                        </div>

                        {isLive && (
                            <div className="linker-lock">
                                Остановите вывод, чтобы изменить название, ID и частоту потока
                            </div>
                        )}
                        </div>

                        <div className="field-group">
                            <label className="field-label">Режим вывода</label>
                            <div className="rot-seg" role="group" aria-label="Режим вывода">
                                <button
                                    type="button"
                                    aria-pressed={params.viewMode === 'top'}
                                    disabled={!selected || starting}
                                    onClick={() => applyViewMode('top')}
                                >
                                    Сверху
                                </button>
                                <button
                                    type="button"
                                    aria-pressed={params.viewMode === 'surround'}
                                    disabled={!selected || starting}
                                    onClick={() => applyViewMode('surround')}
                                >
                                    Объём
                                </button>
                            </div>
                        </div>

                        {/* Поворот — свойство плоской сшивки, в объёме его нет */}
                        {params.viewMode === 'top' && (
                            <div className="field-group">
                                <label className="field-label">Поворот вывода</label>
                                <div className="rot-seg" role="group" aria-label="Поворот вывода">
                                    {ROTATIONS.map(deg => (
                                        <button
                                            key={deg}
                                            type="button"
                                            aria-pressed={params.rotation === deg}
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
                        <div className="srd-hint">
                            Выберите конфигурацию в списке слева
                        </div>
                    )
                )}

                {status.running ? (
                    <button className="btn btn-accent btn-stream streaming linker-run" onClick={stop}>
                        ■ Остановить вывод
                    </button>
                ) : (
                    <button
                        className="btn btn-accent linker-run"
                        disabled={!complete || starting}
                        onClick={start}
                    >
                        {starting ? 'Запуск...' : '▶ Запустить вывод'}
                    </button>
                )}
            </aside>

            {pendingDelete && (
                <ConfirmModal
                    title="Удалить конфигурацию"
                    confirmText="Удалить"
                    message={
                        `Конфигурация «${pendingDelete.name || pendingDelete.id}» будет удалена без возможности вернуть. ` +
                        'Исчезнут запись в индексе, файлы карт remap и weight, а также привязки камер и параметры запуска. ' +
                        'Пересчитать её можно только заново пройдя калибровку и сборку.'
                    }
                    onCancel={() => setPendingDelete(null)}
                    onConfirm={remove}
                />
            )}
        </main>
    );
}
