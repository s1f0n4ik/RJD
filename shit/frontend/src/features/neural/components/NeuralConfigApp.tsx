import { useEffect, useState } from 'react';
import { neuralApi } from '../api/client';
import { Navbar } from './Navbar';
import type { ConnState, SectionKey } from './Navbar';
import { ConfigurationsSection } from './configurations/ConfigurationsSection';
import { CoresSection } from './cores/CoresSection';
import { JournalSection } from './journal/JournalSection';
import '../styles/theme.css';

/** Корень страницы конфигурации нейронок. */
export function NeuralConfigApp() {
    const [section, setSection] = useState<SectionKey>('configs');
    const [conn, setConn] = useState<ConnState>('connecting');

    // пинг бэкенда для индикатора связи
    useEffect(() => {
        let alive = true;
        const ping = () => {
            neuralApi
                .getStatus()
                .then(() => alive && setConn('connected'))
                .catch(() => alive && setConn('disconnected'));
        };
        ping();
        const t = setInterval(ping, 5000);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, []);

    return (
        <div className="neural-config-root">
        <div className="app">
            <Navbar active={section} onChange={setSection} conn={conn} />
            <div className="page">
                <div className="page-inner">
                    {section === 'configs' && <ConfigurationsSection />}
                    {section === 'cores' && <CoresSection />}
                    {section === 'journal' && <JournalSection />}
                </div>
            </div>
        </div>
        </div>
    );
}

export default NeuralConfigApp;