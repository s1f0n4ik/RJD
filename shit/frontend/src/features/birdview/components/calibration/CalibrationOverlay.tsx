import type { CalOverlayState } from './useCalibrationProcess';

// Оверлей хода калибровки поверх кадра: шаг, ожидание, итог

interface CalibrationOverlayProps {
    state: CalOverlayState;
    onDismiss: () => void;
}

export function CalibrationOverlay({ state, onDismiss }: CalibrationOverlayProps) {
    if (state.kind === 'result') {
        return (
            <div className="ov">
                <div className="ov-card">
                    <div className="t">
                        <span className={`ok-ic${state.ok ? '' : ' err'}`}>{state.ok ? '✓' : '✕'}</span>
                        <div>
                            <b>{state.title}</b>
                            {state.desc && <span>{state.desc}</span>}
                        </div>
                    </div>
                    <div className="f">
                        <button className={`btn btn--sm${state.ok ? ' btn--acc' : ''}`} onClick={onDismiss}>
                            {state.ok ? 'Готово' : 'Закрыть'}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (state.kind === 'indeterminate') {
        return (
            <div className="ov">
                <div className="ov-card">
                    <div className="t">
                        <span className="spin" />
                        <div>
                            <b>{state.label}</b>
                            {state.desc && <span>{state.desc}</span>}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const progress = state.progress ?? 0;
    const clamped = Math.min(100, Math.max(0, progress));

    return (
        <div className="ov">
            <div className="ov-card">
                <div className="t">
                    <span className="spin" />
                    <div>
                        <b>{state.label}</b>
                        {state.desc && <span>{state.desc}</span>}
                    </div>
                </div>

                {state.progress !== null && (
                    <>
                        <div className="bar">
                            <i style={{ width: `${clamped}%` }} />
                        </div>
                        <div className="m">
                            <span>
                                {state.step != null && state.totalSteps != null
                                    ? `Шаг ${state.step} / ${state.totalSteps}`
                                    : ''}
                            </span>
                            <span>
                                {state.itemCurrent != null && state.itemTotal != null
                                    ? `${state.itemCurrent} / ${state.itemTotal}`
                                    : `${Math.round(progress)}%`}
                            </span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
