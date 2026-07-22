import { useEffect, useRef, useState } from 'react';
import { linkerApi } from '../../api/linker';
import type { LinkerBindings, LinkerCamera, LinkerExport, LinkerStatus } from '../../api/linker';
import { useToast } from '../common/Toast';
import { ExportsList } from './ExportsList';
import { BindingsList } from './BindingsList';
import { StreamView } from './StreamView';

/**
 * Экран «Отображение» (линкер). Порт page-3.
 *
 * Данные тянутся по требованию: конфигурации и камеры — на активацию экрана,
 * привязка — на клик по конфигурации. Отдельно от них статус линкера
 * опрашивается по таймеру, пока экран активен: иначе пилюля и вид потока
 * врут, если линкер остановили снаружи или он упал.
 */

const STATUS_POLL_MS = 5_000;
const START_POLL_MS = 1_000;
const START_TIMEOUT_MS = 20_000;

const EMPTY_STATUS: LinkerStatus = { running: false, streamId: null, exportId: null };

interface LinkerScreenProps {
    active: boolean;
}

export function LinkerScreen({ active }: LinkerScreenProps) {
    const showToast = useToast();

    const [exports, setExports] = useState<LinkerExport[]>([]);
    const [cameras, setCameras] = useState<LinkerCamera[]>([]);
    const [loading, setLoading] = useState(true);

    const [selectedExport, setSelectedExport] = useState<LinkerExport | null>(null);
    const [bindings, setBindings] = useState<LinkerBindings>({});

    const [status, setStatus] = useState<LinkerStatus>(EMPTY_STATUS);
    const [view, setView] = useState<'setup' | 'stream'>('setup');
    const [starting, setStarting] = useState(false);

    // Во время запуска статус опрашивается отдельным, более частым циклом
    const startingRef = useRef(starting);
    startingRef.current = starting;

    // Конфигурации и камеры — на каждую активацию экрана. Список конфигураций
    // пополняет соседний экран конфигуратора через тот же /linker/exports.
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
                if (!alive) return;
                showToast('Не удалось загрузить', e instanceof Error ? e.message : String(e), 'err');
            })
            .finally(() => {
                if (alive) setLoading(false);
            });

        return () => {
            alive = false;
        };
    }, [active]);

    // Опрос статуса — только пока экран активен
    useEffect(() => {
        if (!active) return;

        const id = window.setInterval(() => {
            if (startingRef.current) return;
            linkerApi.getStatus().then(setStatus).catch(() => {});
        }, STATUS_POLL_MS);

        return () => window.clearInterval(id);
    }, [active]);

    // Линкер остановлен, а мы смотрим поток — уходим в настройку. Иначе плеер
    // будет бесконечно ретраить подключение к несуществующему стриму.
    useEffect(() => {
        if (view === 'stream' && !starting && !status.running) {
            setView('setup');
            showToast('Поток остановлен', 'Линкер больше не работает', 'info');
        }
    }, [status.running, view, starting]);

    const handleSelectExport = async (exp: LinkerExport) => {
        setSelectedExport(exp);
        setBindings(await linkerApi.getStateFor(exp.id));
    };

    const handleBindingChange = (key: string, cameraId: string | null) => {
        setBindings(prev => {
            const next = { ...prev };
            if (cameraId) next[key] = cameraId;
            else delete next[key];
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

    const handleApply = async () => {
        if (!selectedExport) return;

        setStarting(true);
        try {
            await linkerApi.saveState(selectedExport.id, bindings);
            await linkerApi.start();

            const ready = await waitForStream();
            if (!ready) throw new Error('Стрим не поднялся за 20 секунд');

            setStatus(ready);
            setView('stream');
            showToast('Запущено', 'Линкер работает', 'ok');
        } catch (e) {
            showToast('Ошибка запуска', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setStarting(false);
        }
    };

    const handleStop = async () => {
        try {
            await linkerApi.stop();
        } catch (e) {
            showToast('Ошибка остановки', e instanceof Error ? e.message : String(e), 'err');
        }
        setView('setup');
        linkerApi.getStatus().then(setStatus).catch(() => {});
    };

    const canResume = status.running && Boolean(status.streamId);
    const bindingKeys = selectedExport?.cameras ?? [];

    return (
        <main className={`main-layout linker-layout ${active ? '' : 'hidden'}`}>
            <section className="linker-page">

                {view === 'setup' && (
                    <>
                        <button
                            className={`linker-stream-pill${canResume ? ' active' : ''}`}
                            disabled={!canResume}
                            onClick={() => canResume && setView('stream')}
                        >
                            <span className="linker-stream-pill-dot" />
                            <span className="linker-stream-pill-text">
                                {canResume ? 'Подключиться к потоку' : 'Поток не активен'}
                            </span>
                        </button>

                        <div className="linker-setup">
                            <div className="linker-section">
                                <div className="linker-section-title">Конфигурация stitching</div>
                                <ExportsList
                                    exports={exports}
                                    selectedId={selectedExport?.id ?? null}
                                    loading={loading}
                                    onSelect={handleSelectExport}
                                />
                            </div>

                            {bindingKeys.length > 0 && (
                                <div className="linker-section">
                                    <div className="linker-section-title">Привязка камер</div>
                                    <BindingsList
                                        keys={bindingKeys}
                                        cameras={cameras}
                                        bindings={bindings}
                                        onChange={handleBindingChange}
                                    />
                                </div>
                            )}

                            <div className="linker-actions">
                                <button
                                    className="btn btn-accent"
                                    disabled={!selectedExport || starting}
                                    onClick={handleApply}
                                >
                                    {starting ? 'Запуск...' : '⊙ Применить и запустить'}
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {view === 'stream' && status.streamId && (
                    <StreamView streamId={status.streamId} onStop={handleStop} />
                )}

            </section>
        </main>
    );
}
