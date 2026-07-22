import { useEffect, useRef } from 'react';
import type { Distortion } from './useDistortion';
import { SLIDER_KEYS } from './useDistortion';
import type { SliderKey } from '../../api/ws-types';

/** Блок коррекции искажений. Порт correctionBlock и distortion.js. */

const LABELS: Record<SliderKey, string> = {
    alpha: 'Альфа',
    zoom: 'Приближение',
    shift_x: 'Смещение по X',
    shift_y: 'Смещение по Y',
    k1: 'k1',
    k2: 'k2',
    k3: 'k3',
    k4: 'k4',
    radius: 'Радиус панорамы',
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

interface DistortionPanelProps {
    visible: boolean;
    distortion: Distortion;
}

export function DistortionPanel({ visible, distortion }: DistortionPanelProps) {
    return (
        <section className={`panel-block panel-block--hidden${visible ? ' visible' : ''}`}>
            <div className="block-header">
                <span className="block-icon">⊛</span>
                <span className="block-title">Коррекция искажений</span>
            </div>

            <div className={`distortion-body${distortion.visible ? ' visible' : ''}`}>
                <details className="collapsible">
                    <summary className="collapsible-header" style={{ fontSize: 11 }}>
                        <span>Настройка</span>
                        <span className="collapsible-arrow">›</span>
                    </summary>
                    {SLIDER_KEYS.map(key => (
                        <DistortionSlider key={key} sliderKey={key} distortion={distortion} />
                    ))}
                </details>

                <label className="toggle-row" style={{ padding: '6px 2px' }}>
                    <span className="toggle-label">Отображать коррекцию</span>
                    <input
                        className="toggle-input"
                        type="checkbox"
                        checked={distortion.showUndistort}
                        onChange={distortion.toggleShowUndistort}
                    />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>

                <label className="toggle-row" style={{ padding: '6px 2px' }}>
                    <span className="toggle-label">Использовать панорамную развёртку</span>
                    <input
                        className="toggle-input"
                        type="checkbox"
                        checked={distortion.panorama}
                        onChange={distortion.togglePanorama}
                    />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>

                {distortion.panorama && (
                    <div className="collapsible-body" style={{ gap: 6, padding: '0 2px' }}>
                        <DistortionSlider sliderKey="radius" distortion={distortion} />
                    </div>
                )}
            </div>
        </section>
    );
}

interface SliderProps {
    sliderKey: SliderKey;
    distortion: Distortion;
}

function DistortionSlider({ sliderKey, distortion }: SliderProps) {
    const ref = useRef<HTMLInputElement>(null);
    const cfg = distortion.configs[sliderKey];
    const value = distortion.values[sliderKey];

    // Коммит вешаем нативным change: в React onChange у input[type=range]
    // отображается на событие input и срабатывает на каждое движение ползунка,
    // а undistort_compute на сервере тяжёлый — слать его на каждый пиксель нельзя.
    const commitRef = useRef(distortion.commit);
    commitRef.current = distortion.commit;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onCommit = () => commitRef.current(sliderKey);
        el.addEventListener('change', onCommit);
        return () => el.removeEventListener('change', onCommit);
    }, [sliderKey]);

    const fmt = (n: number) => Number(n).toFixed(cfg.decimals);

    return (
        <div className="dist-slider-row">
            <div className="dist-slider-head">
                <label className="field-label">{LABELS[sliderKey]}</label>
                <span className="field-label dist-slider-current">{fmt(value)}</span>
            </div>

            <input
                ref={ref}
                className="dist-slider"
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

            <div className="dist-slider-labels">
                <span>{fmt(cfg.min)}</span>
                <span>{fmt(cfg.mid)}</span>
                <span>{fmt(cfg.max)}</span>
            </div>
        </div>
    );
}
