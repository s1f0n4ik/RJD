import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';

// Поле с якорем-джойстиком: тяга вверх или вниз задаёт скорость изменения, а не само значение

// Ход якоря до полного отклонения
const MAX_PULL = 84;
// За сколько секунд полностью отклонённый джойстик проходит весь диапазон
const FULL_SWING_SEC = 6;
// Как часто значение уходит потребителю, пока идёт тяга
const SEND_MS = 100;

interface JoystickFieldProps {
    label: string;
    value: number;
    min: number;
    /** Потолок значения; Infinity — потолка нет */
    max: number;
    /** Ход полностью отклонённого якоря за FULL_SWING_SEC; по умолчанию весь диапазон */
    swing?: number;
    decimals: number;
    /** Серый текст, когда поле пустое по смыслу */
    placeholder?: string;
    /** Новое значение на каждом кадре тяги */
    onChange: (value: number) => void;
    /** Раз в 100 мс во время тяги и кадром позже после отпускания; отдаёт последнее выданное значение */
    onLive: (value: number) => void;
    /** Значение зафиксировано вводом с клавиатуры */
    onInput: (value: number) => void;
    onGrab?: () => void;
    onRelease?: () => void;
}

export function JoystickField({
    label,
    value,
    min,
    max,
    swing,
    decimals,
    placeholder,
    onChange,
    onLive,
    onInput,
    onGrab,
    onRelease,
}: JoystickFieldProps) {
    const [draft, setDraft] = useState(() => value.toFixed(decimals));
    const [pull, setPull] = useState(0);
    const [dragging, setDragging] = useState(false);

    const gripRef = useRef<HTMLSpanElement>(null);
    const rafRef = useRef(0);
    const pullRef = useRef(0);
    const startYRef = useRef(0);
    const lastTsRef = useRef(0);
    const lastSentRef = useRef(0);

    const valueRef = useRef(value);
    valueRef.current = value;
    // Последнее выданное тягой значение: пропс отстаёт на кадр, отправлять надо это
    const emittedRef = useRef(value);

    const cbRef = useRef({ onChange, onLive, onRelease });
    cbRef.current = { onChange, onLive, onRelease };

    // Значение пришло снаружи, из тяги или из ввода
    useEffect(() => {
        setDraft(value.toFixed(decimals));
    }, [value, decimals]);

    const commit = () => {
        const parsed = Number(draft.replace(',', '.'));
        if (!Number.isFinite(parsed)) {
            setDraft(value.toFixed(decimals));
            return;
        }
        const clamped = Math.max(min, Math.min(max, parsed));
        if (clamped === value) {
            setDraft(clamped.toFixed(decimals));
            return;
        }
        onInput(clamped);
    };

    // Отклонение задаёт скорость: за FULL_SWING_SEC полностью отклонённый якорь проходит весь диапазон
    const tick = (now: number) => {
        rafRef.current = requestAnimationFrame(tick);

        const dt = Math.min(0.05, (now - lastTsRef.current) / 1000);
        lastTsRef.current = now;

        const t = Math.max(-1, Math.min(1, pullRef.current / MAX_PULL));
        if (t !== 0) {
            const span = (swing ?? max - min) / FULL_SWING_SEC;
            const next = valueRef.current + t * Math.abs(t) * span * dt;
            const clamped = Math.max(min, Math.min(max, next));
            if (clamped !== valueRef.current) {
                emittedRef.current = clamped;
                cbRef.current.onChange(clamped);
            }
        }

        // Значение у потребителя отстаёт на кадр, поэтому отправка идёт по таймеру, а не следом за onChange
        if (now - lastSentRef.current >= SEND_MS) {
            lastSentRef.current = now;
            cbRef.current.onLive(emittedRef.current);
        }
    };

    const stopDrag = () => {
        if (!rafRef.current) return;
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        pullRef.current = 0;
        setPull(0);
        setDragging(false);

        // Кадром позже: к этому моменту последнее значение уже у потребителя
        requestAnimationFrame(() => cbRef.current.onLive(emittedRef.current));
        cbRef.current.onRelease?.();
    };

    const stopDragRef = useRef(stopDrag);
    stopDragRef.current = stopDrag;

    useEffect(() => () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }, []);

    // Курсор мог уйти мимо сценария: потеря захвата, отпускание вне окна, уход со вкладки
    useEffect(() => {
        if (!dragging) return;
        const end = () => stopDragRef.current();
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
        window.addEventListener('blur', end);
        return () => {
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            window.removeEventListener('blur', end);
        };
    }, [dragging]);

    const onGripDown = (e: React.PointerEvent) => {
        e.preventDefault();
        gripRef.current?.setPointerCapture(e.pointerId);
        startYRef.current = e.clientY;
        pullRef.current = 0;
        setPull(0);
        setDragging(true);
        emittedRef.current = valueRef.current;
        onGrab?.();
        lastTsRef.current = performance.now();
        lastSentRef.current = performance.now();
        rafRef.current = requestAnimationFrame(tick);
    };

    const onGripMove = (e: React.PointerEvent) => {
        if (!rafRef.current) return;
        pullRef.current = startYRef.current - e.clientY;
        setPull(Math.max(-1, Math.min(1, pullRef.current / MAX_PULL)));
    };

    // Минимум 8%: при слабой тяге полоска иначе вырождается в нитку
    const width = pull === 0 ? 0 : 8 + Math.abs(pull) * 42;

    return (
        <div className="tf">
            <span className="tf-cap">{label}</span>
            <div className={`jf${dragging ? ' is-live' : ''}`}>
                <span className="jf-scale">
                    <i className="jf-zero" />
                    <i
                        className="jf-fill"
                        style={{ width: `${width}%`, left: pull >= 0 ? '50%' : `${50 - width}%` }}
                    />
                </span>
                <input
                    className="jf-in"
                    value={draft}
                    placeholder={placeholder}
                    onChange={e => setDraft(e.target.value)}
                    onFocus={() => onGrab?.()}
                    onBlur={() => {
                        commit();
                        onRelease?.();
                    }}
                    onKeyDown={e => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                />
                {pull !== 0 && (
                    <span className="jf-dir">{`${pull > 0 ? '▲' : '▼'} ${Math.round(Math.abs(pull) * 100)}%`}</span>
                )}
                <span
                    ref={gripRef}
                    className="jf-grip"
                    data-tip="Тяните вверх или вниз"
                    onPointerDown={onGripDown}
                    onPointerMove={onGripMove}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    onLostPointerCapture={stopDrag}
                >
                    <Icon name="grip" size={13} className="ico" />
                </span>
            </div>
        </div>
    );
}
