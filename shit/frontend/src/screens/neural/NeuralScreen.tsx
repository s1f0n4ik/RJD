import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { useSystem } from '../../app/SystemContext';
import { setNeuralStatus } from '../../app/neuralStatus';
import { getRouting } from '../../services/devices';
import { ToastProvider } from '../../features/birdview/components/common/Toast';
import { neuralApi } from '../../features/neural/api/client';
import type { SlotStatus } from '../../features/neural/api/types';
import { JournalSection } from '../../features/neural/components/journal/JournalSection';
import { ConfigsScreen } from './ConfigsScreen';
import { StreamsScreen } from './StreamsScreen';
import { NEURAL_SECTIONS, isNeuralSection } from './sections';
import './neural.css';

const STATUS_POLL_MS = 3000;

/**
 * Корень раздела «Техническое зрение» на /neural/<подраздел>.
 * Статус слотов опрашивается здесь: он нужен и потокам, и точке в рельсе.
 */
export default function NeuralScreen() {
    const { section = '' } = useParams();
    const navigate = useNavigate();
    const { devices } = useSystem();

    const deviceId = getRouting().neural;
    const device = deviceId ? devices.find(d => d.id === deviceId) ?? null : null;
    const online = Boolean(device && device.status === 'online' && device.modules.includes('neural'));

    if (!online) {
        return (
            <section className="screen nv-screen">
                <div className="notice">
                    <Icon name="warn" className="ico" />
                    <h2>Техническое зрение недоступно</h2>
                    <p>{!deviceId ? 'Модуль neural не назначен ни одному устройству' : device ? `Устройство ${device.name} не в сети` : 'Назначенное устройство не найдено'}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn--acc" onClick={() => navigate('/devices')}>Открыть устройства</button>
                        <button className="btn" onClick={() => navigate('/')}>На главную</button>
                    </div>
                </div>
            </section>
        );
    }

    if (!isNeuralSection(section)) {
        return <Navigate to={`/neural/${NEURAL_SECTIONS[0].id}`} replace />;
    }

    return (
        <ToastProvider>
            <NeuralContent section={section} />
        </ToastProvider>
    );
}

function NeuralContent({ section }: { section: string }) {
    // null — статус ещё не приходил или устройство не ответило
    const [status, setStatus] = useState<SlotStatus[] | null>(null);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                const slots = await neuralApi.getStatus();
                if (!alive) return;
                setStatus(slots);
                setNeuralStatus({ running: slots.some(s => s.running), failed: slots.some(s => s.code !== 0) });
            } catch {
                if (alive) setStatus(null);
            }
        };
        load();
        const timer = window.setInterval(load, STATUS_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [tick]);

    return (
        <section className="screen nv-screen">
            {section === 'configs' && <ConfigsScreen />}
            {section === 'streams' && <StreamsScreen status={status} onRefreshStatus={() => setTick(t => t + 1)} />}
            {section === 'journal' && <JournalSection />}
        </section>
    );
}
