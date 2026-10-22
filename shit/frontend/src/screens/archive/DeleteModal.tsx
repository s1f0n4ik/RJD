import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import type { DeleteResult, Segment, Track } from './model';
import {
    dateKey, deleteRange, fetchSegments, fmtBytes, fmtDate, fmtDuration, fmtTime, isAvailable, trackKey,
} from './model';

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

// Что уйдёт у дорожки: все задетые закрытые сегменты целиком, пишущийся остаётся
interface Plan {
    files: number;
    bytes: number;
    from: number;
    to: number;
    gone: Segment[];
    open: Segment | null;
}

function planOf(segments: Segment[], from: number, to: number): Plan {
    const hit = segments.filter(s => s.end_ms > from && s.start_ms < to);
    const doomed = hit.filter(s => s.closed);
    return {
        files: doomed.length,
        bytes: doomed.reduce((sum, s) => sum + (s.size_bytes || 0), 0),
        from: doomed.length ? Math.min(...doomed.map(s => s.start_ms)) : from,
        to: doomed.length ? Math.max(...doomed.map(s => s.end_ms)) : to,
        gone: doomed.filter(s => s.available === false),
        open: hit.find(s => !s.closed) ?? null,
    };
}

export function DeleteModal({ tracks, cameraNames, range, preselected, onClose, onDeleted }: Props) {
    // Окно работает с дорожками на момент открытия: опрос формы архива его не перестраивает
    const [opened] = useState(tracks);
    // Дорожки, у которых в диапазоне есть хоть что-то, включая куски на неподключённых дисках
    const touched = useMemo(
        () => opened.filter(track => track.runs.some(run => run.end_ms > range.from && run.start_ms < range.to)),
        [opened, range.from, range.to],
    );
    const [plans, setPlans] = useState<Map<string, Plan> | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(() => new Set(preselected));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        Promise.all(touched.map(track =>
            fetchSegments(track, range.from, range.to).then(data => [trackKey(track), planOf(data.segments, range.from, range.to)] as const),
        ))
            .then(list => { if (alive) setPlans(new Map(list)); })
            .catch(e => { if (alive) setError(String(e)); });
        return () => { alive = false; };
    }, [touched, range.from, range.to]);

    const rows = touched.map(track => {
        const key = trackKey(track);
        const plan = plans?.get(key) ?? null;
        return { track, key, plan, name: cameraNames.get(track.camera_id) || track.camera_id, on: chosen.has(key) && !!plan?.files };
    });
    const picked = rows.filter(row => row.on);
    const bounds = picked.length
        ? { from: Math.min(...picked.map(row => row.plan!.from)), to: Math.max(...picked.map(row => row.plan!.to)) }
        : null;
    const files = picked.reduce((sum, row) => sum + row.plan!.files, 0);
    const bytes = picked.reduce((sum, row) => sum + row.plan!.bytes, 0);

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
        if (!picked.length || busy) return;
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
            setError(String(e));
            setBusy(false);
        }
    };

    const gone = picked.filter(row => row.plan!.gone.length);
    const writing = rows.filter(row => chosen.has(row.key) && row.plan?.open);

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
                    <HoldButton
                        disabled={!files || busy}
                        label={busy ? 'Удаляем…' : files ? `Удалить ${files} ${plural(files, 'файл', 'файла', 'файлов')}` : 'Нечего удалять'}
                        onHold={submit}
                    />
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
                        <b className="is-del">{bounds ? span(bounds.from, bounds.to) : '—'}</b>
                        <em>{bounds ? 'по границам файлов' : ''}</em>
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

                    {rows.map(({ track, key, plan, name, on }) => (
                        <button
                            type="button"
                            key={key}
                            className={`dm-trk${on ? ' is-on' : ''}`}
                            disabled={!plan?.files}
                            onClick={() => toggle(key)}
                        >
                            <span className="dm-trk-h">
                                <i className="dm-chk" />
                                <span className="dm-nm">
                                    <b>
                                        {name}
                                        {!!plan?.gone.length && <span className="del-chip is-disk">«{plan.gone[0].disk || 'диск'}» не подключён</span>}
                                        {plan?.open && <span className="del-chip is-live">пишется</span>}
                                    </b>
                                    <span>{track.camera_id} · {track.stream_key.replace('stream_', 'канал ')}</span>
                                </span>
                                <span className="dm-num seps">
                                    {!plan && <span>считаем…</span>}
                                    {plan && !plan.files && <span>удалять нечего</span>}
                                    {plan && !!plan.files && (
                                        <>
                                            <span>{fmtTime(plan.from).slice(0, 5)} — {fmtTime(plan.to).slice(0, 5)}</span>
                                            <span>{plan.files} {plural(plan.files, 'файл', 'файла', 'файлов')}</span>
                                            <span>≈ {fmtBytes(plan.bytes)}</span>
                                        </>
                                    )}
                                </span>
                            </span>
                            <Lane track={track} plan={plan} range={range} ctx={ctx} />
                        </button>
                    ))}
                </div>

                {(gone.length > 0 || writing.length > 0) && (
                    <div className="sect del-notes">
                        {gone.map(({ key, name, plan }) => (
                            <div key={key} className="del-note is-disk">
                                <Icon name="warn" size={15} />
                                <div>
                                    <b>«{plan!.gone[0].disk || 'Диск'}» не подключён.</b>
                                    {' '}Записи «{name}» за {fmtTime(plan!.gone[0].start_ms).slice(0, 5)} — {fmtTime(plan!.gone[plan!.gone.length - 1].end_ms).slice(0, 5)}
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
                                    {' '}{writing.map(({ name, plan }) => `«${name}» с ${fmtTime(plan!.open!.start_ms)}`).join(', ')}.
                                    {' '}{writing.length > 1 ? 'Эти файлы ещё не закрыты и останутся.' : 'Этот файл ещё не закрыт и останется.'}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {error && <div className="sect dm-err">{error}</div>}
            </div>
        </Modal>
    );
}

// Полоса дорожки: запись, неподключённый диск, что уйдёт, пишущийся файл и выделение пунктиром
function Lane({ track, plan, range, ctx }: {
    track: Track;
    plan: Plan | null;
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
            {plan?.open && box('o', plan.open.start_ms, plan.open.end_ms, 'open')}
            {!!plan?.files && box('d', plan.from, plan.to, 'del')}
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

function plural(count: number, one: string, few: string, many: string): string {
    const tail = count % 10;
    if (count % 100 >= 11 && count % 100 <= 14) return many;
    if (tail === 1) return one;
    if (tail >= 2 && tail <= 4) return few;
    return many;
}
