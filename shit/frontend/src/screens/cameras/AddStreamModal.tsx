import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { api } from '../../services/api';
import type { ProbeReason, ProbeResult } from '../../types';
import { MAX_SUBSTREAM, MIN_SUBSTREAM, formatError } from './model';

export interface ProbeConnection {
    ip_adress: string;
    port: string;
    user: string;
    password: string;
    production: number;
}

interface AddStreamModalProps {
    deviceId: string;
    connection: ProbeConnection;
    /** Уже заведённые субпотоки: показываются в списке отмеченными, не опрашиваются */
    existing: FoundStream[];
    onPick: (found: FoundStream[]) => void;
    onClose: () => void;
}

/** Что опрос узнал о субпотоке; уходит вызывающему вместе с выбором. */
export interface FoundStream {
    substream: number;
    width: number;
    height: number;
    codec: string;
    fps: number;
}

const PROBE_TIMEOUT = 3;

// Отказы, после которых опрос прекращается
const FATAL_REASONS: ProbeReason[] = ['auth', 'unreachable'];

const FATAL_TEXT: Partial<Record<ProbeReason, string>> = {
    auth: 'Камера отклонила логин или пароль — опрос остановлен',
    unreachable: 'Камера не отвечает по этому адресу и порту — опрос остановлен',
};

const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'поток' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'потока' : 'потоков');

/** Опрос камеры и выбор субпотоков: последовательно по всем свободным номерам, добавляются сразу несколько. */
export function AddStreamModal({ deviceId, connection, existing, onPick, onClose }: AddStreamModalProps) {
    const [found, setFound] = useState<FoundStream[]>([]);
    const [picked, setPicked] = useState<number[]>([]);
    const [current, setCurrent] = useState<number | null>(null);
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);

    // Номер серии опроса; по нему чужая серия себя опознаёт
    const runRef = useRef(0);

    const used = existing.map(s => s.substream);
    const targets: number[] = [];
    for (let n = MIN_SUBSTREAM; n <= MAX_SUBSTREAM; n++) {
        if (!used.includes(n)) targets.push(n);
    }
    const targetsKey = targets.join(',');

    useEffect(() => {
        const run = ++runRef.current;
        const alive = () => runRef.current === run;

        setFound([]);
        setPicked([]);
        setError('');
        setDone(false);

        const sweep = async () => {
            for (const substream of targets) {
                if (!alive()) return;
                setCurrent(substream);

                try {
                    const result: ProbeResult = await api.probeStream(deviceId, {
                        ...connection,
                        substream,
                        timeout: PROBE_TIMEOUT,
                    });

                    if (!alive()) return;

                    if (result.result === 'success') {
                        // Номер попадает в список только один раз; найденное сразу отмечено
                        setFound(prev => prev.some(f => f.substream === substream)
                            ? prev
                            : [...prev, {
                                substream,
                                width: result.width ?? 0,
                                height: result.height ?? 0,
                                codec: result.codec ?? '',
                                fps: result.fps ?? 0,
                            }]);
                        setPicked(prev => (prev.includes(substream) ? prev : [...prev, substream]));
                    }
                    else if (result.reason && FATAL_REASONS.includes(result.reason)) {
                        setError(FATAL_TEXT[result.reason] ?? result.details ?? 'Опрос остановлен');
                        break;
                    }
                    // Молчащий субпоток не показываем
                }
                catch (err) {
                    if (!alive()) return;
                    setError(formatError(err));
                    break;
                }
            }

            if (alive()) {
                setCurrent(null);
                setDone(true);
            }
        };

        void sweep();

        // Смена номера отменяет серию
        return () => { runRef.current++; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deviceId, targetsKey]);

    const stop = () => {
        runRef.current++;
        setCurrent(null);
        setDone(true);
    };

    const toggle = (substream: number) =>
        setPicked(prev => (prev.includes(substream) ? prev.filter(n => n !== substream) : [...prev, substream]));

    const submit = () => {
        const chosen = found.filter(f => picked.includes(f.substream));
        if (chosen.length) onPick(chosen);
    };

    const total = targets.length;
    const checked = current === null
        ? total
        : targets.indexOf(current) + 1;

    // Заведённые и найденные — один список по номеру субпотока
    const rows = [
        ...existing.map(item => ({ item, added: true })),
        ...found.map(item => ({ item, added: false })),
    ].sort((a, b) => a.item.substream - b.item.substream);

    return (
        <Modal
            title="Добавить поток"
            onClose={onClose}
            footer={
                <>
                    <button className="btn btn--ghost" onClick={onClose}>Закрыть</button>
                    <span className="spacer" />
                    {!done && (
                        <button className="btn" onClick={stop}>Остановить</button>
                    )}
                    <button className="btn btn--acc" disabled={picked.length === 0} onClick={submit}>
                        {picked.length ? `Добавить ${picked.length} ${plural(picked.length)}` : 'Добавить'}
                    </button>
                </>
            }
        >
            <div className="modal-b">
                <div className="probe-head">
                    {done ? (
                        <span className="hint" style={{ margin: 0 }}>
                            {found.length > 0
                                ? `Опрос завершён, найдено новых субпотоков: ${found.length}`
                                : 'Опрос завершён, свободных субпотоков не нашлось'}
                        </span>
                    ) : (
                        <span className="hint" style={{ margin: 0 }}>
                            <span className="spin" />
                            Проверяем субпоток {current} — {checked} из {total}
                        </span>
                    )}
                </div>

                {error && (
                    <div className="banner is-err" style={{ marginBottom: 12 }}>
                        <Icon name="warn" size={15} />
                        {error}
                    </div>
                )}

                {rows.length > 0 && (
                    <div className="probe-list">
                        {rows.map(({ item, added }) => (
                            <label
                                key={item.substream}
                                className={`probe-row${added ? ' is-added' : picked.includes(item.substream) ? ' is-on' : ''}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={added || picked.includes(item.substream)}
                                    disabled={added}
                                    onChange={() => toggle(item.substream)}
                                />
                                <span className="who">
                                    <b>Субпоток {item.substream} — {item.width > 0 ? `${item.width}×${item.height}` : 'разрешение неизвестно'}</b>
                                    <span className="sub">
                                        <span>Кодек {item.codec ? item.codec.toUpperCase() : 'не определён'}</span>
                                        {Boolean(item.fps) && <span>{item.fps} кадров/с</span>}
                                        {added && <span>уже в камере</span>}
                                    </span>
                                </span>
                            </label>
                        ))}
                    </div>
                )}

                {found.length === 0 && !error && (
                    <p className="hint" style={{ marginTop: 12 }}>
                        Показываются только те субпотоки, с которых реально пошло видео.
                    </p>
                )}
            </div>
        </Modal>
    );
}
