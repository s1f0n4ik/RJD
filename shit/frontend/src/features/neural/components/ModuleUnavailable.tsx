import '../styles/theme.css';

/** Заглушка страницы техзрения: модуль neural не запущен ни на одном устройстве. */
export function NeuralUnavailable() {
    return (
        <div
            className="neural-config-root"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
            <div style={{ textAlign: 'center', fontFamily: 'var(--font-ui)', padding: 24 }}>
                <div
                    style={{
                        fontSize: 64,
                        fontWeight: 800,
                        color: 'var(--accent)',
                        textShadow: '0 0 48px var(--accent-glow)',
                        marginBottom: 8,
                    }}
                >
                    ⦿
                </div>
                <div
                    style={{
                        fontSize: 26,
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        marginBottom: 12,
                        letterSpacing: '-0.01em',
                    }}
                >
                    Страница недоступна
                </div>
                <div
                    style={{
                        color: 'var(--text-secondary)',
                        maxWidth: 420,
                        margin: '0 auto 28px',
                        lineHeight: 1.5,
                    }}
                >
                    Модуль «Техническое зрение» не запущен ни на одном устройстве.
                    Подключите устройство с этим модулем в разделе «Устройства».
                </div>
                <a
                    href="/app"
                    style={{
                        display: 'inline-block',
                        padding: '11px 26px',
                        borderRadius: 'var(--radius)',
                        background: 'var(--accent)',
                        color: '#fff',
                        fontWeight: 600,
                        textDecoration: 'none',
                    }}
                >
                    На главную
                </a>
            </div>
        </div>
    );
}
