export type SectionKey = 'configs' | 'cores';
export type ConnState = 'connected' | 'connecting' | 'disconnected';

interface NavbarProps {
  active: SectionKey;
  onChange: (s: SectionKey) => void;
  conn: ConnState;
}

const CONN_LABEL: Record<ConnState, string> = {
  connected: 'CONNECTED',
  connecting: 'CONNECTING',
  disconnected: 'OFFLINE',
};

export function Navbar({ active, onChange, conn }: NavbarProps) {
  return (
    <div className="navbar">
      <div className="nav-brand">
        <span className="nav-logo">◈</span>
        <span className="nav-title">Varan</span>
        <span className="nav-version">/ neural</span>
      </div>

      <div className="nav-steps">
        <button
          className={`nav-step${active === 'configs' ? ' active' : ''}`}
          onClick={() => onChange('configs')}
        >
          <span className="step-num">01</span> Конфигурации
        </button>
        <button
          className={`nav-step${active === 'cores' ? ' active' : ''}`}
          onClick={() => onChange('cores')}
        >
          <span className="step-num">02</span> Ядра NPU
        </button>
      </div>

      <div className="nav-right">
        <div className={`status-pill ${conn}`}>
          <span className="status-dot" />
          {CONN_LABEL[conn]}
        </div>
      </div>
    </div>
  );
}
