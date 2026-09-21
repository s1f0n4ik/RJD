import { useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon, IconSprite, type IconName } from '../app/Icons';
import { crumbsFor } from '../app/nav';
import { isAdmin } from '../app/role';
import { useSystem } from '../app/SystemContext';
import { formatDeviceTime, useDeviceClock } from '../app/useDeviceClock';
import './mobile.css';

interface Tab {
    to: string;
    label: string;
    icon: IconName;
    admin?: boolean;
}

// Разделы мобильной оболочки: только наблюдение
export const TABS: Tab[] = [
    { to: '/', label: 'Главная', icon: 'home' },
    { to: '/cameras', label: 'Камеры', icon: 'cam' },
    { to: '/archive', label: 'Архив', icon: 'arch' },
    { to: '/neural/journal', label: 'Журнал', icon: 'eye' },
    { to: '/devices', label: 'Устройства', icon: 'dev', admin: true },
];

export function tabsFor(role: string): Tab[] {
    return TABS.filter(tab => !tab.admin || isAdmin(role));
}

function canOpenMobile(pathname: string, role: string): boolean {
    return tabsFor(role).some(tab => pathname === tab.to);
}

export interface ShellContext {
    username: string;
    role: string;
    onLogout: () => void;
    // Узел в шапке: экран порталит туда свой контрол
    slot: HTMLElement | null;
}

interface MobileShellProps {
    username: string;
    role: string;
    onLogout: () => void;
}

export function MobileShell(props: MobileShellProps) {
    const { role } = props;
    const { pathname } = useLocation();
    const { connected, devices } = useSystem();
    const { unixMs, source } = useDeviceClock();
    const [slot, setSlot] = useState<HTMLElement | null>(null);

    // Закрытый адрес уводит на главную, пояснение уезжает в state
    if (!canOpenMobile(pathname, role)) {
        const closed = pathname === '/' ? '' : crumbsFor(pathname)[0];
        return <Navigate to="/" replace state={closed ? { closed } : undefined} />;
    }

    const offlineDevices = devices.filter(d => d.status !== 'online').length;
    const title = crumbsFor(pathname).slice(-1)[0];
    const screen = pathname === '/' ? 'home' : pathname.split('/').filter(Boolean).slice(-1)[0];

    return (
        <div className="m-shell" data-screen={screen}>
            <IconSprite />

            <header className="m-hd">
                <h1>{title}</h1>
                <div className="m-hd-slot" ref={setSlot} />
                <span className={`pill ${connected ? 'ok' : 'err'}`}>
                    <span className="dot" />
                    {connected ? 'связь' : 'нет связи'}
                </span>
                <span
                    className={`pill num${source === 'can' ? '' : ' is-dim'}`}
                    title={source === 'can' ? 'Время изделия' : 'Время сервера, шина молчит'}
                >
                    {formatDeviceTime(unixMs)}
                </span>
                <a className="m-hd-btn" href="/translation" aria-label="Прямая трансляция">
                    <Icon name="play" />
                </a>
            </header>

            <div className="m-stage">
                <Outlet context={{ ...props, slot } satisfies ShellContext} />
            </div>

            <nav className="m-tabs" aria-label="Разделы">
                {tabsFor(role).map(tab => (
                    <NavLink
                        key={tab.to}
                        to={tab.to}
                        end={tab.to === '/'}
                        className={({ isActive }) => `m-tab${isActive ? ' is-on' : ''}`}
                    >
                        <Icon name={tab.icon} size={22} />
                        {tab.to === '/devices' && offlineDevices > 0 && <span className="m-bdg">{offlineDevices}</span>}
                        {tab.label}
                    </NavLink>
                ))}
            </nav>
        </div>
    );
}
