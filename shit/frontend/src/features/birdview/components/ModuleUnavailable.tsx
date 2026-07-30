import '../styles/theme.css';

/** Заглушка страницы 360: модуль birdview не запущен ни на одном устройстве. */
export function BirdviewUnavailable() {
    return (
        <div
            className="birdview-root"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
            <div style={{ textAlign: 'center', fontFamily: 'var(--bv-font-ui)', padding: 24 }}>
                <div
                    style={{
                        fontSize: 72,
                        fontWeight: 800,
                        color: 'var(--bv-accent)',
                        textShadow: '0 0 40px var(--bv-accent-glow)',
                        marginBottom: 8,
                    }}
                >
                    360°
                </div>
                <div
                    style={{
                        fontSize: 28,
                        fontWeight: 800,
                        color: 'var(--bv-text-primary)',
                        marginBottom: 12,
                    }}
                >
                    Страница недоступна
                </div>
                <div
                    style={{
                        color: 'var(--bv-text-secondary)',
                        maxWidth: 420,
                        margin: '0 auto 28px',
                        lineHeight: 1.5,
                    }}
                >
                    Модуль «Система 360» не запущен ни на одном устройстве.
                    Подключите устройство с этим модулем в разделе «Устройства».
                </div>
                <a
                    href="/app"
                    style={{
                        display: 'inline-block',
                        padding: '12px 28px',
                        borderRadius: 'var(--bv-radius)',
                        background: 'var(--bv-accent)',
                        color: 'var(--bv-bg-base)',
                        fontWeight: 700,
                        textDecoration: 'none',
                    }}
                >
                    На главную
                </a>
            </div>
        </div>
    );
}
