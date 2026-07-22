import type { CalOverlayState } from './useCalibrationProcess';

/** Оверлей хода калибровки поверх кадра. Порт calOverlay. */

interface CalibrationOverlayProps {
    state: CalOverlayState;
    onDismiss: () => void;
}

export function CalibrationOverlay({ state, onDismiss }: CalibrationOverlayProps) {
    if (state.kind === 'result') {
        return (
            <div className="cal-overlay">
                <div className={`cal-result-icon ${state.ok ? 'ok' : 'err'}`}>
                    {state.ok ? '✓' : '✕'}
                </div>
                <div className={`cal-result-title ${state.ok ? 'ok' : 'err'}`}>{state.title}</div>
                {state.desc && <div className="cal-result-desc">{state.desc}</div>}
                <button
                    className={`btn ${state.ok ? 'btn-accent' : 'btn-ghost'}`}
                    onClick={onDismiss}
                >
                    {state.ok ? 'Готово' : 'Закрыть'}
                </button>
            </div>
        );
    }

    if (state.kind === 'indeterminate') {
        return (
            <div className="cal-overlay">
                <div className="cal-indeterminate">
                    <div className="cal-indeterminate-bar" />
                </div>
                <div className="cal-step-label">{state.label}</div>
                {state.desc && <div className="cal-step-desc">{state.desc}</div>}
            </div>
        );
    }

    const progress = state.progress ?? 0;
    const clamped = Math.min(100, Math.max(0, progress));

    return (
        <div className="cal-overlay">
            <div className="cal-spinner" />
            <div className="cal-step-label">{state.label}</div>
            {state.desc && <div className="cal-step-desc">{state.desc}</div>}

            {state.progress !== null && (
                <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span className="cal-step-counter">
                            {state.step != null && state.totalSteps != null
                                ? `Шаг ${state.step} / ${state.totalSteps}`
                                : ''}
                        </span>
                        <span className="cal-step-counter">
                            {state.itemCurrent != null && state.itemTotal != null
                                ? `${state.itemCurrent} / ${state.itemTotal}`
                                : `${Math.round(progress)}%`}
                        </span>
                    </div>
                    <div className="cal-progress-track">
                        <div className="cal-progress-fill" style={{ width: `${clamped}%` }} />
                    </div>
                </div>
            )}
        </div>
    );
}
