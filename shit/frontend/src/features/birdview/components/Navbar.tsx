import type { ScreenId } from '../types';

/** Верхняя панель со шагами и статусами. Порт navbar из birdview.html. */

const STEPS: Array<{ id: ScreenId; label: string }> = [
    { id: 'calibration', label: 'Калибровка' },
    { id: 'projection', label: 'Сборка' },
    { id: 'linker', label: 'Отображение' },
    { id: 'configurator', label: 'Конфигуратор' },
];

export type ConnState = 'connected' | 'connecting' | 'disconnected';

interface NavbarProps {
    screen: ScreenId;
    onScreenChange: (screen: ScreenId) => void;
    wsState: ConnState;
    rtcWsState: ConnState;
    rtcState: ConnState;
}

const WS_TEXT: Record<ConnState, string> = {
    connected: 'OK',
    connecting: '...',
    disconnected: '—',
};

export function Navbar({ screen, onScreenChange, wsState, rtcWsState, rtcState }: NavbarProps) {
    return (
        <nav className="navbar">
            <div className="nav-brand">
                <span className="nav-title">Система 360</span>
            </div>

            <div className="nav-steps">
                {STEPS.map((step, i) => (
                    <div key={step.id} style={{ display: 'contents' }}>
                        {i > 0 && <div className="nav-step-divider" />}
                        <div
                            className={`nav-step ${screen === step.id ? 'active' : ''}`}
                            onClick={() => onScreenChange(step.id)}
                        >
                            <span className="nav-step-label">{step.label}</span>
                            <span className="nav-step-indicator" />
                        </div>
                    </div>
                ))}
            </div>

            <div className="nav-right">
                <div className="nav-status-area">
                    <StatusPill state={wsState} label="WS" />
                    <StatusPill state={rtcWsState} label="RTC WS" />
                    <StatusPill state={rtcState} label="RTC" />
                </div>

                <button className="nav-admin-btn" onClick={() => { window.location.href = '/'; }}>
                    <span className="nav-admin-icon">⊹</span>
                    <span>На главную</span>
                </button>
            </div>
        </nav>
    );
}

function StatusPill({ state, label }: { state: ConnState; label: string }) {
    return (
        <div className={`status-pill ${state}`}>
            <span className="status-dot" />
            <span className="status-text">{label}: {WS_TEXT[state]}</span>
        </div>
    );
}
