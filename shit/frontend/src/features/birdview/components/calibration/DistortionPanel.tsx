import { useEffect, useRef } from 'react';
import { Switch } from '../../../../app/Modal';
import type { Distortion } from './useDistortion';
import type { SliderKey } from '../../api/ws-types';
import { JoystickField } from '../shared/JoystickField';

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

// Сколько держим защиту от эха после отпускания: ответы на команды тяги приходят с задержкой
const SETTLE_MS = 600;

function CoefField({ sliderKey, distortion }: SliderProps) {
    const cfg = distortion.configs[sliderKey];
    const value = Number(distortion.values[sliderKey]);

    const settleRef = useRef<number | null>(null);
    const pendingRef = useRef(false);

    // Коммит уходит после того, как новое значение попало в состояние
    useEffect(() => {
        if (!pendingRef.current) return;
        pendingRef.current = false;
        distortion.commit(sliderKey);
    }, [value]);

    const holdOff = () => {
        if (settleRef.current) window.clearTimeout(settleRef.current);
        settleRef.current = window.setTimeout(() => {
            settleRef.current = null;
            distortion.setHeld(null);
        }, SETTLE_MS);
    };

    useEffect(() => () => {
        if (settleRef.current) window.clearTimeout(settleRef.current);
    }, []);

    return (
        <JoystickField
            label={LABELS[sliderKey]}
            value={value}
            min={cfg.min}
            max={cfg.max}
            decimals={cfg.decimals}
            onChange={v => distortion.setValue(sliderKey, v)}
            onLive={() => distortion.commit(sliderKey)}
            onInput={v => {
                pendingRef.current = true;
                distortion.setValue(sliderKey, v);
            }}
            onGrab={() => {
                if (settleRef.current) {
                    window.clearTimeout(settleRef.current);
                    settleRef.current = null;
                }
                distortion.setHeld(sliderKey);
            }}
            onRelease={holdOff}
        />
    );
}
