import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAdmin } from './role';
import { updateApi, type UpLock } from '../screens/settings/update-api';

const SLOW_MS = 5000;
const FAST_MS = 2000;
const PHASE: Record<string, string> = { delivery: 'доставка', install: 'установка', master: 'часть мастера', rollback: 'откат' };

// Плашка хода обновления на любом экране; пока мастер перезапускает службы, держится последняя фаза
export function UpdatePill({ role }: { role: string }) {
    const navigate = useNavigate();
    const [lock, setLock] = useState<UpLock | null>(null);
    const busy = !!lock?.busy;

    useEffect(() => {
        let alive = true;
        const load = () => updateApi.lock()
            .then(next => { if (alive) setLock(next); })
            .catch(() => undefined);
        void load();
        const timer = window.setInterval(() => void load(), busy ? FAST_MS : SLOW_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [busy]);

    if (!lock?.busy) return null;
    const label = `${lock.kind === 'revert' ? 'Возврат версии' : 'Обновление'}: ${PHASE[lock.phase ?? ''] ?? 'завершение'}`;
    const ring = <i className="ring is-wait" />;

    return isAdmin(role)
        ? <button type="button" className="pill pill--job" onClick={() => navigate('/settings/update')}>{ring}{label}</button>
        : <span className="pill pill--job">{ring}{label}</span>;
}
