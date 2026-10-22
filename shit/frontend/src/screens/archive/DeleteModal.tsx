import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import type { DeletePlan, DeleteResult, Track } from './model';
import {
    DeviceOutdated, dateKey, deleteRange, estimateBytes, fmtBytes, fmtDate, fmtDuration, fmtTime, goneWithin,
    isAvailable, previewDelete, recordedWithin, trackKey,
} from './model';

const failureText = (device: string, e: unknown) => (e instanceof DeviceOutdated
    ? `«${device}» не умеет удалять записи: на нём старая версия архива (storage-service).`
    : `«${device}» не ответило: ${e instanceof Error ? e.message : String(e)}.`);

// Удержание кнопки удаления, мс
const HOLD_MS = 1500;

interface Props {
    tracks: Track[];
    cameraNames: Map<string, string>;
    range: { from: number; to: number };
    preselected: string[];
    onClose: () => void;
    onDeleted: (result: DeleteResult) => void;
}

const keyOf = (deviceId: string, camera: string, stream: string) => `${deviceId}/${camera}/${stream}`;

export function DeleteModal({ tracks, cameraNames, range, preselected, onClose, onDeleted }: Props) {
    // Окно работает с дорожками на момент открытия: опрос формы архива его не перестраивает
    const [opened] = useState(tracks);
    // Дорожки, у которых в диапазоне есть хоть что-то, включая куски на неподключённых дисках
    const touched = useMemo(
        () => opened.filter(track => track.runs.some(run => run.end_ms > range.from && run.start_ms < range.to)),
        [opened, range.from, range.to],
    );
    // Итоги устройства по дорожкам; пока их нет, строки показывают оценку по форме архива
    const [plans, setPlans] = useState<Map<string, DeletePlan>>(new Map());
    // Устройства, которые не посчитали файлы: их камеры выключены
    const [failed, setFailed] = useState<Map<string, string>>(new Map());
    const [chosen, setChosen] = useState<Set<string>>(() => new Set(preselected));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        const byDevice = new Map<string, Track[]>();
        touched.forEach(track => byDevice.set(track.device_id, [...(byDevice.get(track.device_id) ?? []), track]));

        byDevice.forEach((list, deviceId) => {
            const refs = list.map(track => ({ camera: track.camera_id, stream: track.stream_key }));
            previewDelete(deviceId, refs, range.from, range.to)
                .then(data => {
                    if (!alive) return;
                    setPlans(current => {
                        const next = new Map(current);
                        refs.forEach(ref => {
                            const plan = data.tracks.find(p => p.camera === ref.camera && p.stream === ref.stream);
                            next.set(keyOf(deviceId, ref.camera, ref.stream), plan ?? {
                                ...ref, files: 0, bytes: 0, from_ms: null, to_ms: null, gone: null, open_from: null,
                            });
                        });
                        return next;
                    });
                })
                .catch(e => {
                    if (alive) setFailed(current => new Map(current).set(deviceId, failureText(list[0].device_name || deviceId, e)));
                });
        });
        return () => { alive = false; };
    }, [touched, range.from, range.to]);

    const rows = touched.map(track => {
        const key = trackKey(track);
        const plan = plans.get(key) ?? null;
        const down = failed.has(track.device_id);
        const recorded = recordedWithin(track, range.from, range.to) + goneWithin(track, range.from, range.to);
        const deletable = !down && (plan ? plan.files > 0 : recorded > 0);
        return {
            track, key, plan, recorded, deletable, down,
            name: cameraNames.get(track.camera_id) || track.camera_id,
            on: chosen.has(key) && deletable,
        };
    });
    const picked = rows.filter(row => row.on);
    const counted = picked.every(row => row.plan);
    const exact = picked.map(row => row.plan).filter((plan): plan is DeletePlan => !!plan && plan.files > 0);
    const bounds = counted && exact.length
        ? { from: Math.min(...exact.map(p => p.from_ms!)), to: Math.max(...exact.map(p => p.to_ms!)) }
        : null;
    const files = exact.reduce((sum, plan) => sum + plan.files, 0);
    const bytes = picked.reduce((sum, row) => sum + (row.plan ? row.plan.bytes : estimateBytes(row.track, row.recorded)), 0);

    // Полосы показывают выделение с запасом: видно, насколько удаление шире выделенного
    const ctx = useMemo(() => {
        const lo = Math.min(range.from, bounds?.from ?? range.from);
        const hi = Math.max(range.to, bounds?.to ?? range.to);
        const pad = (hi - lo) * 0.08;
        return { from: lo - pad, to: hi + pad };
    }, [range.from, range.to, bounds?.from, bounds?.to]);

    const toggle = (key: string) => setChosen(current => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

    const submit = async () => {
        if (!files || busy) return;
        setBusy(true);
        setError(null);

        const byDevice = new Map<string, Array<{ camera: string; stream: string }>>();
        picked.forEach(({ track }) => {
            const list = byDevice.get(track.device_id) ?? [];
            list.push({ camera: track.camera_id, stream: track.stream_key });
            byDevice.set(track.device_id, list);
        });

        try {
            const results = await Promise.all(
                [...byDevice].map(([deviceId, list]) => deleteRange(deviceId, list, range.from, range.to)),
            );
            onDeleted(results.reduce((sum, r) => ({
                removed: sum.removed + r.removed,
                bytes: sum.bytes + r.bytes,
                deferred: sum.deferred + r.deferred,
                kept_open: sum.kept_open + r.kept_open,
            }), { removed: 0, bytes: 0, deferred: 0, kept_open: 0 }));
        } catch (e) {
            setError(e instanceof DeviceOutdated
                ? 'Устройство не умеет удалять записи: на нём старая версия архива (storage-service).'
                : `Удаление не прошло: ${e instanceof Error ? e.message : String(e)}`);
            setBusy(false);
        }
    };

    const gone = picked.filter(row => row.plan?.gone);
    const writing = rows.filter(row => chosen.has(row.key) && row.plan?.open_from != null);

    const label = busy
        ? 'Удаляем…'
        : !counted
            ? 'Считаем файлы…'
            : files ? `Удалить ${files} ${plural(files, 'файл', 'файла', 'файлов')}` : 'Нечего удалять';

    return (
        <Modal
            title="Удалить записи"
            size="mid"
            className="del-modal"
            onClose={onClose}
            footer={(
                <>
                    <div className="dm-total">
                        <b>≈ {fmtBytes(bytes)}</b>
                        <span>{picked.length} {plural(picked.length, 'камера', 'камеры', 'камер')}</span>
                    </div>
                    <button type="button" className="btn btn--ghost" onClick={onClose}>Отмена</button>
                    <HoldButton disabled={!counted || !files || busy} label={label} onHold={submit} />
                </>
            )}
        >
            <div className="modal-b dm-body">
                <div className="sect dm-line">
                    <span className="eyebrow">Диапазон</span>
                    <div className="del-bounds">
                        <span>Выделено</span>
                        <b>{span(range.from, range.to)}</b>
                        <em>{fmtDuration(range.to - range.from)}</em>
                        <span>Удалится</span>
                        {counted ? (
                            <>
                                <b className="is-del del-in">{bounds ? span(bounds.from, bounds.to) : '—'}</b>
                                <em className="del-in">{bounds ? 'по границам файлов' : ''}</em>
                            </>
                        ) : (
                            <>
                                <b className="del-wait">уточняем по файлам</b>
                                <em />
                            </>
                        )}
                    </div>
                </div>

                <div className="sect">
                    <span className="eyebrow">
                        Камеры
                        <span className="dm-count">{picked.length} из {rows.length}</span>
                    </span>

                    <div className="dm-scale">
                        <i className="is-start">{fmtTime(ctx.from)}</i>
                        <i className="is-end">{fmtTime(ctx.to)}</i>
                    </div>

                    {rows.map(({ track, key, plan, recorded, deletable, down, name, on }) => (
                        <button
                            type="button"
                            key={key}
                            className={`dm-trk${on ? ' is-on' : ''}`}
                            disabled={!deletable}
                            onClick={() => toggle(key)}
                        >
                            <span className="dm-trk-h">
                                <i className="dm-chk" />
                                <span className="dm-nm">
                                    <b>
                                        {name}
                                        {plan?.gone && <span className="del-chip is-disk del-in">«{plan.gone.disk}» не подключён</span>}
                                        {plan?.open_from != null && <span className="del-chip is-live del-in">пишется</span>}
                                    </b>
                                    <span>{track.camera_id} · {track.stream_key.replace('stream_', 'канал ')}</span>
                                </span>
                                {down ? (
                                    <span className="dm-num seps"><span>недоступно</span></span>
                                ) : plan ? (
                                    <span className="dm-num seps del-in">
                                        {plan.files ? (
                                            <>
                                                <span>{short(plan.from_ms!, plan.to_ms!)}</span>
                                                <span>{plan.files} {plural(plan.files, 'файл', 'файла', 'файлов')}</span>
                                                <span>≈ {fmtBytes(plan.bytes)}</span>
                                            </>
                                        ) : <span>удалять нечего</span>}
                                    </span>
                                ) : (
                                    <span className="dm-num seps is-guess">
                                        <span>≈ {fmtDuration(recorded)}</span>
                                        <span>≈ {fmtBytes(estimateBytes(track, recorded))}</span>
                                    </span>
                                )}
                            </span>
                            <Lane track={track} plan={plan} range={range} ctx={ctx} />
                        </button>
                    ))}
                </div>

                {(gone.length > 0 || writing.length > 0) && (
                    <div className="sect del-notes del-in">
                        {gone.map(({ key, name, plan }) => (
                            <div key={key} className="del-note is-disk">
                                <Icon name="warn" size={15} />
                                <div>
                                    <b>«{plan!.gone!.disk}» не подключён.</b>
                                    {' '}Записи «{name}» за {short(plan!.gone!.from_ms, plan!.gone!.to_ms)}
                                    {' '}уйдут из архива сейчас, а файлы удалятся с диска, когда его подключат к этому устройству.
                                    {' '}Если диск подключат к другому устройству, файлы там останутся.
                                </div>
                            </div>
                        ))}
                        {writing.length > 0 && (
                            <div className="del-note is-live">
                                <Icon name="clock" size={15} />
                                <div>
                                    <b>{writing.length > 1 ? 'Пишутся сейчас:' : 'Пишется сейчас:'}</b>
                                    {' '}{writing.map(({ name, plan }) => `«${name}» с ${fmtTime(plan!.open_from!)}`).join(', ')}.
                                    {' '}{writing.length > 1 ? 'Эти файлы ещё не закрыты и останутся.' : 'Этот файл ещё не закрыт и останется.'}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {(failed.size > 0 || error) && (
                    <div className="sect del-notes">
                        {[...failed.values(), ...(error ? [error] : [])].map(text => (
                            <div key={text} className="del-note is-err">
                                <Icon name="warn" size={15} />
                                <div>{text}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Modal>
    );
}

// Полоса дорожки: запись, неподключённый диск, что уйдёт, пишущийся файл и выделение пунктиром
function Lane({ track, plan, range, ctx }: {
    track: Track;
    plan: DeletePlan | null;
    range: { from: number; to: number };
    ctx: { from: number; to: number };
}) {
    const pct = (ms: number) => ((ms - ctx.from) / (ctx.to - ctx.from)) * 100;
    const box = (className: string, a: number, b: number, key: string | number) => {
        const left = Math.max(0, pct(a));
        const right = Math.min(100, pct(b));
        return right > left ? <i key={key} className={className} style={{ left: `${left}%`, width: `${right - left}%` }} /> : null;
    };

    return (
        <span className="del-ln">
            {track.runs.map(run => box(isAvailable(run) ? 'r' : 'g', run.start_ms, run.end_ms, run.start_ms))}
            {plan?.open_from != null && box('o', plan.open_from, Math.max(plan.open_from, range.to), 'open')}
            {!!plan?.files && box('d', plan.from_ms!, plan.to_ms!, 'del')}
            {box('s', range.from, range.to, 'sel')}
        </span>
    );
}

// Нажатие запускает заливку; удаление — только если продержать до конца, раньше отпустил — встряска
function HoldButton({ disabled, label, onHold }: { disabled: boolean; label: string; onHold: () => void }) {
    const [state, setState] = useState<'idle' | 'press' | 'shake'>('idle');
    const [hint, setHint] = useState(false);
    const timer = useRef(0);
    const done = useRef(false);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    // Удаление не прошло — кнопка снова ждёт удержания
    useEffect(() => {
        if (disabled || !done.current) return;
        done.current = false;
        setState('idle');
    }, [disabled]);

    const start = () => {
        if (disabled || state === 'press') return;
        done.current = false;
        setState('press');
        timer.current = window.setTimeout(() => {
            done.current = true;
            onHold();
        }, HOLD_MS);
    };

    const stop = () => {
        if (state !== 'press' || done.current) return;
        window.clearTimeout(timer.current);
        setState('shake');
        setHint(true);
        window.setTimeout(() => setHint(false), 1300);
    };

    return (
        <button
            type="button"
            className={`del-hold${state === 'press' || done.current ? ' is-press' : ''}${state === 'shake' ? ' is-shake' : ''}`}
            disabled={disabled}
            onPointerDown={event => { if (event.button === 0) start(); }}
            onPointerUp={stop}
            onPointerLeave={stop}
            onPointerCancel={stop}
            onKeyDown={event => {
                if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                    event.preventDefault();
                    start();
                }
            }}
            onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') stop(); }}
            onAnimationEnd={() => setState('idle')}
        >
            <Icon name="trash" size={14} />
            <span>{hint ? 'Держите 1,5 с' : label}</span>
        </button>
    );
}

function span(from: number, to: number): string {
    const sameDay = dateKey(from) === dateKey(to);
    return `${fmtDate(from)} ${fmtTime(from)} — ${sameDay ? '' : `${fmtDate(to)} `}${fmtTime(to)}`;
}

// Границы без секунд; дата — только когда отрезок переходит через сутки
function short(from: number, to: number): string {
    const hm = (ms: number) => fmtTime(ms).slice(0, 5);
    if (dateKey(from) === dateKey(to)) return `${hm(from)} — ${hm(to)}`;
    const dm = (ms: number) => fmtDate(ms).slice(0, 5);
    return `${dm(from)} ${hm(from)} — ${dm(to)} ${hm(to)}`;
}

function plural(count: number, one: string, few: string, many: string): string {
    const tail = count % 10;
    if (count % 100 >= 11 && count % 100 <= 14) return many;
    if (tail === 1) return one;
    if (tail >= 2 && tail <= 4) return few;
    return many;
}
