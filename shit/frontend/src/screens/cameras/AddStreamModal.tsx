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
    /** Уже заведённые субпотоки: их не опрашиваем и не предлагаем */
    used: number[];
    onPick: (found: FoundStream) => void;
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

// Отказ, после которого продолжать бессмысленно: дальше будет то же самое
const FATAL_REASONS: ProbeReason[] = ['auth', 'unreachable'];

const FATAL_TEXT: Partial<Record<ProbeReason, string>> = {
    auth: 'Камера отклонила логин или пароль — опрос остановлен',
    unreachable: 'Камера не отвечает по этому адресу и порту — опрос остановлен',
};

/**
 * Опрос камеры и выбор субпотока. Идём последовательно по всем свободным
 * номерам без раннего выхода: у многоматричных камер живые субпотоки могут
 * начинаться не с первого, и остановка на первом молчащем их скрыла бы.
 * Ненайденные не показываем — оператору важно, что есть, а не чего нет.
 */
export function AddStreamModal({ deviceId, connection, used, onPick, onClose }: AddStreamModalProps) {
    const [found, setFound] = useState<FoundStream[]>([]);
    const [current, setCurrent] = useState<number | null>(null);
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);

    /*
        Номер серии опроса. Именно номер, а не флаг: StrictMode в разработке
        прогоняет эффект дважды, и булев флаг второй запуск возвращал в true —
        старая серия оживала и дописывала свои находки второй раз.
    */
    const runRef = useRef(0);

    const targets: number[] = [];
    for (let n = MIN_SUBSTREAM; n <= MAX_SUBSTREAM; n++) {
        if (!used.includes(n)) targets.push(n);
    }
    const targetsKey = targets.join(',');

    useEffect(() => {
        const run = ++runRef.current;
        const alive = () => runRef.current === run;

        setFound([]);
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
                        // Защита от повторной записи: номер в списке только один
                        setFound(prev => prev.some(f => f.substream === substream)
                            ? prev
                            : [...prev, {
                                substream,
                                width: result.width ?? 0,
                                height: result.height ?? 0,
                                codec: result.codec ?? '',
                                fps: result.fps ?? 0,
                            }]);
                    }
                    else if (result.reason && FATAL_REASONS.includes(result.reason)) {
                        setError(FATAL_TEXT[result.reason] ?? result.details ?? 'Опрос остановлен');
                        break;
                    }
                    // Молчащий субпоток — это просто его отсутствие, не показываем
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

        // Смена номера отменяет серию: старая себя опознает и выйдет
        return () => { runRef.current++; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deviceId, targetsKey]);

    const stop = () => {
        runRef.current++;
        setCurrent(null);
        setDone(true);
    };

    const total = targets.length;
    const checked = current === null
        ? total
        : targets.indexOf(current) + 1;

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
                </>
            }
        >
            <div className="modal-b">
                <div className="probe-head">
                    {done ? (
                        <span className="hint" style={{ margin: 0 }}>
                            {found.length > 0
                                ? `Опрос завершён, найдено субпотоков: ${found.length}`
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

                {found.length > 0 && (
                    <div className="probe-list">
                        {found.map(item => (
                            <button
                                key={item.substream}
                                type="button"
                                className="probe-row"
                                onClick={() => onPick(item)}
                            >
                                <span className="chnum">{item.substream}</span>
                                <span className="who">
                                    <b>{item.width > 0 ? `${item.width}×${item.height}` : 'разрешение неизвестно'}</b>
                                    <span className="sub">
                                        {item.codec ? item.codec.toUpperCase() : '—'}
                                        {item.fps ? ` · ${item.fps} к/с` : ''}
                                    </span>
                                </span>
                                <span className="btn btn--sm btn--acc">Добавить</span>
                            </button>
                        ))}
                    </div>
                )}

                {found.length === 0 && !error && (
                    <p className="hint" style={{ marginTop: 12 }}>
                        Показываются только те субпотоки, с которых реально пошло видео.
                        Уже заведённые в этой камере не опрашиваются.
                    </p>
                )}
            </div>
        </Modal>
    );
}
