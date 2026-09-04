import { useEffect, useRef, useState } from 'react';
import { Switch } from '../../../../app/Modal';
import type { Distortion } from './useDistortion';
import type { SliderKey } from '../../api/ws-types';

// Блок «Коррекция»: ползунки, коэффициенты, панорама

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

const RANGE_KEYS: SliderKey[] = ['alpha', 'zoom', 'shift_x', 'shift_y'];
const COEF_KEYS: SliderKey[] = ['k1', 'k2', 'k3', 'k4'];

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
                <div className="tf-row">
                    {COEF_KEYS.map(key => (
                        <CoefField key={key} sliderKey={key} distortion={distortion} />
                    ))}
                </div>

                <div className="sub-h">Панорама</div>
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

    return (
        <div className={`tf${off ? ' is-off' : ''}`}>
            <span className="tf-cap">{LABELS[sliderKey]}</span>
            <div className="tf-range">
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
                <span className="val">{Number(value).toFixed(cfg.decimals)}</span>
            </div>
        </div>
    );
}

function CoefField({ sliderKey, distortion }: SliderProps) {
    const cfg = distortion.configs[sliderKey];
    const value = distortion.values[sliderKey];
    const [draft, setDraft] = useState(() => Number(value).toFixed(cfg.decimals));

    // Значение пришло с сервера или из ползунка
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
        const parsed = Number(draft);
        if (!Number.isFinite(parsed)) {
            setDraft(Number(value).toFixed(cfg.decimals));
            return;
        }
        if (parsed === value) return;
        pendingRef.current = true;
        distortion.setValue(sliderKey, parsed);
    };

    return (
        <div className="tf">
            <span className="tf-cap">{LABELS[sliderKey]}</span>
            <input
                className="tf-in"
                type="number"
                step={STEPS[sliderKey]}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onFocus={() => distortion.setHeld(sliderKey)}
                onBlur={() => {
                    distortion.setHeld(null);
                    commit();
                }}
                onWheel={e => e.currentTarget.blur()}
                onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                }}
            />
        </div>
    );
}
