import { useCallback, useEffect, useState } from 'react';
import { loadDevices } from '../services/devices';
import { Icon, IconSprite } from './Icons';

/**
 * Шлагбаум перед приложением: реестр устройств должен лежать в кэше до
 * первого рендера — экраны читают getDevices() синхронно прямо в разметке.
 *
 * Ожидание закрывает сплэш из index.html: он уже на экране к моменту, когда
 * этот компонент монтируется, и снимается только при уходе из loading.
 * Поэтому в loading здесь рендерится null: два спиннера подряд не нужны.
 */

// Страховка от подвисшего nginx: живой бэкенд отвечает из памяти за миллисекунды
const TIMEOUT_MS = 8000;

type Status = 'loading' | 'ready' | 'failed';

export function Bootstrap({ children }: { children: React.ReactNode }) {
    const [status, setStatus] = useState<Status>('loading');
    const [error, setError] = useState('');

    const attempt = useCallback(() => {
        setStatus('loading');
        setError('');

        const controller = new AbortController();
        // AbortSignal.timeout не используется: версия движка на плате не гарантирована
        const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);

        loadDevices(controller.signal)
            .then(() => setStatus('ready'))
            .catch((e: unknown) => {
                setError(
                    controller.signal.aborted
                        ? `Мастер не ответил за ${TIMEOUT_MS / 1000} с`
                        : (e as Error)?.message || String(e),
                );
                setStatus('failed');
            })
            .finally(() => window.clearTimeout(timer));
    }, []);

    useEffect(attempt, [attempt]);

    useEffect(() => {
        if (status === 'loading') return;
        document.getElementById('boot')?.remove();
    }, [status]);

    if (status === 'loading') return null;
    if (status === 'ready') return <>{children}</>;

    return (
        <div className="login-wrap">
            <IconSprite />
            <div className="notice">
                <Icon name="warn" className="ico" />
                <h2>Реестр устройств недоступен</h2>
                <p>
                    Не удалось получить список устройств от мастера. Без него модули
                    показываются недоступными, а маршрутизация не работает.
                </p>
                <p className="hint is-err">{error}</p>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn--acc" onClick={attempt}>Повторить</button>
                    <button className="btn" onClick={() => setStatus('ready')}>Продолжить без реестра</button>
                </div>
            </div>
        </div>
    );
}
