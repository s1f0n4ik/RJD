import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { linkerApi, LinkerError } from '../../api/linker';
import type {
    LinkerBindings,
    LinkerCamera,
    LinkerExport,
    LinkerExportDetail,
    LinkerParams,
    LinkerStatus,
} from '../../api/linker';
import WebRTCPlayer from '../../../../components/WebRTCPlayer';
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
};

const DEFAULT_PARAMS: LinkerParams = {
    fps: 15,
    streamId: DEFAULT_STREAM_ID,
    streamName: '',
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

    // Во время запуска общий опрос молчит: за подъёмом следит свой цикл
    const startingRef = useRef(starting);
    startingRef.current = starting;

    // fps правится черновиком: зажатие в 1..60 на каждое нажатие клавиши
    // не даёт набрать «15», превращая первую единицу в готовое значение
    const [fpsDraft, setFpsDraft] = useState(String(DEFAULT_PARAMS.fps));

    useEffect(() => {
        setFpsDraft(String(params.fps));
    }, [params.fps]);

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

    // Линкер остановлен, а мы смотрим поток — возвращаемся к схеме. Иначе плеер
    // будет бесконечно ретраить подключение к несуществующему стриму
    useEffect(() => {
        if (view === 'stream' && !starting && !status.running) {
            setView('plan');
        }
    }, [status.running, view, starting]);

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
            setBindings(state.bindings);
            setParams({
                fps: state.params.fps ?? DEFAULT_PARAMS.fps,
                streamId: state.params.streamId ?? DEFAULT_STREAM_ID,
                streamName: state.params.streamName ?? full.name,
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
            showToast('Запущено', params.streamName || selected.name, 'ok');
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

    const geometry = useMemo(() => (detail ? buildGeometry(detail) : null), [detail]);

    const places = detail?.places.length ?? 0;
    const assigned = detail ? detail.places.filter(p => bindings[p.key]).length : 0;
    const complete = places > 0 && assigned === places;

    const isLive = status.running && status.exportId === selected?.id;
    const canWatch = status.running && Boolean(status.streamId);

    return (
        <main className={`main-layout linker-layout ${active ? '' : 'hidden'}`}>
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
                            return (
                                <div
                                    key={exp.id}
                                    className={`linker-cfg${selected?.id === exp.id ? ' on' : ''}`}
                                    onClick={() => !starting && selectExport(exp)}
                                >
                                    <span className="linker-cfg-dot" />
                                    <span className="linker-cfg-body">
                                        <span className="linker-cfg-name">{exp.name || exp.id}</span>
                                        <span className="linker-cfg-meta">
                                            {(exp.cameras?.length ?? 0)} мест · {exp.id}
                                        </span>
                                    </span>
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
                    <span className="linker-kv-k">Камер</span>
                    <span className="linker-kv-v">{assigned} / {places || '—'}</span>
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
                            title={canWatch ? '' : 'Поток не запущен'}
                            onClick={() => canWatch && setView('stream')}
                        >
                            Стрим
                        </button>
                    </span>
                </div>

                <div className="linker-stage">
                    {view === 'stream' && status.streamId ? (
                        <WebRTCPlayer
                            key={`linker-${status.streamId}`}
                            cameraId={status.streamId}
                            signalingUrl={wsUrl(`/signaling/client/${status.streamId}`)}
                        />
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
                    <span className="field-hint">Это имя увидят все на фронте</span>
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
                    <span className="field-hint">По нему стрим ищут. Менять без нужды не стоит</span>
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
                        onKeyDown={e => {
                            if (e.key === 'Enter') commitFps();
                        }}
                    />
                    <span className="field-hint">Выше 25 упрётся в GPU склейки</span>
                </div>

                {status.running ? (
                    <>
                        <button className="btn btn-accent btn-stream streaming" onClick={stop}>
                            ■ Остановить вывод
                        </button>
                        <span className="field-hint linker-center">
                            Изменения применятся после перезапуска
                        </span>
                    </>
                ) : (
                    <>
                        <button
                            className="btn btn-accent"
                            disabled={!complete || starting}
                            onClick={start}
                        >
                            {starting ? 'Запуск...' : '▶ Запустить вывод'}
                        </button>
                        <span className="field-hint linker-center">
                            {!selected
                                ? 'Выберите конфигурацию'
                                : complete
                                  ? 'Все места заняты'
                                  : `Осталось назначить ${places - assigned}`}
                        </span>
                    </>
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
