/**
 * Наложения ячейки: состояние «кадра ещё нет» и исчезающая плашка.
 *
 * Пока видео не идёт, состояние показывается по центру — тем же приёмом, что
 * в предпросмотре камеры: крутилка, что происходит, и причина мелким. Когда
 * кадр идёт, сообщения показываются плашкой поверх него: гаснут сами и
 * закрываются крестиком. Двух мест сразу не бывает.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import type { ErrorInfo } from '../../components/webrtc/error-codes';
import type { PlayerStatus } from '../../components/webrtc/useWebRTCPlayer';

const FLASH_HIDE_MS = 6000;

export interface Flash {
    text: string;
    code: number | null;
    /** err — отказ, info — обычное уведомление */
    tone: 'err' | 'info';
}

export function CellState({ status, error }: { status: PlayerStatus; error: ErrorInfo | null }) {
    const first = status === 'connecting' || status === 'signaling';

    return (
        <div className="cell-state">
            <span className="spin" />
            <span>{first ? 'подключение…' : 'переподключение…'}</span>
            {error && (
                <span className="cell-state-why">
                    {error.text}
                    {error.code !== null && <i className="cell-code">{error.code}</i>}
                </span>
            )}
        </div>
    );
}

export function CellFlash({ flash, onClose }: { flash: Flash; onClose: () => void }) {
    return (
        <div className={`cellv-note${flash.tone === 'err' ? ' is-err' : ''}`}>
            <span>{flash.text}</span>
            {flash.code !== null && <i className="cell-code">{flash.code}</i>}
            <button className="cellv-note-x" onClick={event => { event.stopPropagation(); onClose(); }} aria-label="Закрыть">
                <Icon name="x" size={12} />
            </button>
        </div>
    );
}

/**
 * Одна плашка на ячейку: новое сообщение вытесняет старое, отсчёт начинается
 * заново. В ячейке 2×2 стопка сообщений нечитаема, а история есть в логах.
 */
export function useFlash() {
    const [flash, setFlash] = useState<Flash | null>(null);
    const timerRef = useRef<number | null>(null);

    const hide = useCallback(() => {
        setFlash(null);
        if (timerRef.current) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const show = useCallback((text: string, code: number | null = null, tone: Flash['tone'] = 'err') => {
        setFlash({ text, code, tone });
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            setFlash(null);
        }, FLASH_HIDE_MS);
    }, []);

    useEffect(() => () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
    }, []);

    return { flash, show, hide };
}
