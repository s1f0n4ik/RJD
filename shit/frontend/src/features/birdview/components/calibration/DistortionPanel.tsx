import { useEffect, useRef, useState } from 'react';
import { Switch } from '../../../../app/Modal';
import { Icon } from '../../../../app/Icons';
import type { Distortion } from './useDistortion';
import type { SliderKey } from '../../api/ws-types';

// Блок «Коррекция»: ползунки и коэффициенты. Панорама — отдельный блок ниже

const LABELS: Record<SliderKey, string> = {
    alpha: 'Альфа',
    zoom: 'Приближение',
    shift_x: 'Смещение X',
    shift_y: 'Смещение Y',
    k1: 'k1',
    k2: 'k2',
    k3: 'k3',
    k4: 'k4',
    radius: 'Радиус',
};

const STEPS: Record<SliderKey, number> = {
    alpha: 0.01,
    zoom: 0.005,
    shift_x: 1,
    shift_y: 1,
    k1: 0.00001,
    k2: 0.00001,
    k3: 0.00001,
    k4: 0.00001,
    radius: 1,
};

// Альфа убрана из интерфейса: на кадр она не влияет
const RANGE_KEYS: SliderKey[] = ['zoom', 'shift_x', 'shift_y'];
const COEF_ROWS: SliderKey[][] = [
    ['k1', 'k2'],
    ['k3', 'k4'],
];

interface DistortionPanelProps {
    distortion: Distortion;
    rms: number | null;
}

export function DistortionPanel({ distortion, rms }: DistortionPanelProps) {
    return (
        <>
            <div className="blk-h">
                <h3>Коррекция</h3>
                {rms !== null && (
                    <span className="pill ok spacer">
                        <span className="dot" />
                        RMS {rms.toFixed(2).replace('.', ',')} px
                    </span>
                )}
            </div>
            <div className="blk-b pad">
                {RANGE_KEYS.map(key => (
                    <DistortionSlider key={key} sliderKey={key} distortion={distortion} />
                ))}

                <div className="sub-h">Коэффициенты</div>
                {COEF_ROWS.map(row => (
                    <div className="tf-row" key={row.join()}>
                        {row.map(key => (
                            <CoefField key={key} sliderKey={key} distortion={distortion} />
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
}

export function PanoramaPanel({ distortion }: { distortion: Distortion }) {
    return (
        <>
            <div className="blk-h">
                <h3>Панорама</h3>
            </div>
            <div className="blk-b pad">
                <Switch on={distortion.panorama} onToggle={() => distortion.togglePanorama()}>
                    Панорамная развёртка
                </Switch>
                <DistortionSlider sliderKey="radius" distortion={distortion} off={!distortion.panorama} />
            </div>
        </>
    );
}

interface SliderProps {
    sliderKey: SliderKey;
    distortion: Distortion;
    off?: boolean;
}

function DistortionSlider({ sliderKey, distortion, off }: SliderProps) {
    const ref = useRef<HTMLInputElement>(null);
    const cfg = distortion.configs[sliderKey];
    const value = distortion.values[sliderKey];

    // Коммит нативным change: React onChange у range срабатывает на каждое движение
    const commitRef = useRef(distortion.commit);
    commitRef.current = distortion.commit;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onCommit = () => commitRef.current(sliderKey);
        el.addEventListener('change', onCommit);
        return () => el.removeEventListener('change', onCommit);
    }, [sliderKey]);

    // Дорожка и ручка нарисованы разметкой макета, нативный вход лежит поверх прозрачным
    const span = cfg.max - cfg.min;
    const pct = span > 0 ? ((Number(value) - cfg.min) / span) * 100 : 0;
    const clamped = Math.max(0, Math.min(100, pct));

    return (
        <div className={`rng${off ? ' is-off' : ''}`}>
            <div className="rng-cap">
                <span className="tf-cap">{LABELS[sliderKey]}</span>
                <span className="rng-box">{Number(value).toFixed(cfg.decimals).replace('.', ',')}</span>
            </div>
            <div className="tf-range">
                <span className="track">
                    <i style={{ width: `${clamped}%` }} />
                    <b style={{ left: `${clamped}%` }} />
                </span>
                <input
                    ref={ref}
                    type="range"
                    min={cfg.min}
                    max={cfg.max}
                    step={STEPS[sliderKey]}
                    value={value}
                    onChange={e => distortion.setValue(sliderKey, Number(e.target.value))}
                    onPointerDown={() => distortion.setHeld(sliderKey)}
                    onPointerUp={() => distortion.setHeld(null)}
                    onPointerCancel={() => distortion.setHeld(null)}
                    onFocus={() => distortion.setHeld(sliderKey)}
                    onBlur={() => distortion.setHeld(null)}
                />
            </div>
        </div>
    );
}

// Ход якоря до полного отклонения
const MAX_PULL = 84;
// За сколько секунд полностью отклонённый джойстик проходит весь диапазон
const FULL_SWING_SEC = 6;
// Как часто новое значение уходит на калибратор, пока идёт тяга
const SEND_MS = 100;
// Сколько держим защиту от эха после отпускания: ответы на команды тяги приходят с задержкой
const SETTLE_MS = 600;

function CoefField({ sliderKey, distortion }: SliderProps) {
    const cfg = distortion.configs[sliderKey];
    const value = distortion.values[sliderKey];
    const [draft, setDraft] = useState(() => Number(value).toFixed(cfg.decimals));
    const [pull, setPull] = useState(0);
    const [dragging, setDragging] = useState(false);

    const gripRef = useRef<HTMLSpanElement>(null);
    const rafRef = useRef(0);
    const settleRef = useRef<number | null>(null);
    const pullRef = useRef(0);
    const startYRef = useRef(0);
    const lastTsRef = useRef(0);
    const lastSentRef = useRef(0);
    const valueRef = useRef(value);
    valueRef.current = value;

    const distortionRef = useRef(distortion);
    distortionRef.current = distortion;

    // Значение пришло с сервера, из ползунка или из джойстика
    useEffect(() => {
        setDraft(Number(value).toFixed(cfg.decimals));
    }, [value, cfg.decimals]);

    // Коммит уходит после того, как новое значение попало в состояние
    const pendingRef = useRef(false);
    useEffect(() => {
        if (!pendingRef.current) return;
        pendingRef.current = false;
        distortion.commit(sliderKey);
    }, [value]);

    const commit = () => {
        const parsed = Number(draft.replace(',', '.'));
        if (!Number.isFinite(parsed)) {
            setDraft(Number(value).toFixed(cfg.decimals));
            return;
        }
        if (parsed === value) return;
        pendingRef.current = true;
        distortion.setValue(sliderKey, parsed);
    };

    // Джойстик: отклонение задаёт скорость, а не само значение
    const tick = (now: number) => {
        rafRef.current = requestAnimationFrame(tick);

        const dt = Math.min(0.05, (now - lastTsRef.current) / 1000);
        lastTsRef.current = now;

        const t = Math.max(-1, Math.min(1, pullRef.current / MAX_PULL));
        if (t !== 0) {
            const span = (cfg.max - cfg.min) / FULL_SWING_SEC;
            const next = valueRef.current + t * Math.abs(t) * span * dt;
            const clamped = Math.max(cfg.min, Math.min(cfg.max, next));
            if (clamped !== valueRef.current) distortionRef.current.setValue(sliderKey, clamped);
        }

        // Значение в валуе-рефе хука отстаёт на кадр, поэтому шлём по таймеру, а не следом за setValue
        if (now - lastSentRef.current >= SEND_MS) {
            lastSentRef.current = now;
            distortionRef.current.commit(sliderKey);
        }
    };

    const stopDrag = () => {
        if (!rafRef.current) return;
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        pullRef.current = 0;
        setPull(0);
        setDragging(false);

        // Кадром позже: к этому моменту последнее значение уже лежит в хуке
        requestAnimationFrame(() => distortionRef.current.commit(sliderKey));

        // Защиту снимаем не сразу: ответы на команды тяги ещё в пути и откатили бы значение
        if (settleRef.current) window.clearTimeout(settleRef.current);
        settleRef.current = window.setTimeout(() => {
            settleRef.current = null;
            distortionRef.current.setHeld(null);
        }, SETTLE_MS);
    };

    useEffect(() => () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        if (settleRef.current) window.clearTimeout(settleRef.current);
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

    const stopDragRef = useRef(stopDrag);
    stopDragRef.current = stopDrag;

    const onGripDown = (e: React.PointerEvent) => {
        e.preventDefault();
        gripRef.current?.setPointerCapture(e.pointerId);
        startYRef.current = e.clientY;
        pullRef.current = 0;
        setPull(0);
        setDragging(true);
        if (settleRef.current) {
            window.clearTimeout(settleRef.current);
            settleRef.current = null;
        }
        distortion.setHeld(sliderKey);
        lastTsRef.current = performance.now();
        lastSentRef.current = performance.now();
        rafRef.current = requestAnimationFrame(tick);
    };

    const onGripMove = (e: React.PointerEvent) => {
        if (!rafRef.current) return;
        pullRef.current = startYRef.current - e.clientY;
        setPull(Math.max(-1, Math.min(1, pullRef.current / MAX_PULL)));
    };

    const live = dragging;
    // Минимум 8%: при слабой тяге полоска иначе вырождается в нитку
    const width = pull === 0 ? 0 : 8 + Math.abs(pull) * 42;

    return (
        <div className="tf">
            <span className="tf-cap">{LABELS[sliderKey]}</span>
            <div className={`jf${live ? ' is-live' : ''}`}>
                <span className="jf-scale">
                    <i className="zero" />
                    <i className="bar" style={{ width: `${width}%`, left: pull >= 0 ? '50%' : `${50 - width}%` }} />
                </span>
                <input
                    className="jf-in"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onFocus={() => distortion.setHeld(sliderKey)}
                    onBlur={() => {
                        distortion.setHeld(null);
                        commit();
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
