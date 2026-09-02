import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon, IconSprite } from './Icons';
import { CRUMBS, NAV } from './nav';
import { DownloadsPill } from './DownloadsPill';
import { useSystem } from './SystemContext';
import { formatDeviceTime, useDeviceClock } from './useDeviceClock';
import './shell.css';

interface AppShellProps {
    username: string;
    role: string;
    onLogout: () => void;
}

export function AppShell({ username, role, onLogout }: AppShellProps) {
    const [narrow, setNarrow] = useState(false);
    const { unixMs, source } = useDeviceClock();
    const { connected, cameras, devices } = useSystem();
    const { pathname } = useLocation();

    const offlineDevices = devices.filter(d => d.status !== 'online').length;
    const crumbs = CRUMBS[pathname] ?? ['Главная'];
    const initials = username.slice(0, 2).toUpperCase() || 'ОП';

    return (
        <div className={`shell${narrow ? ' is-narrow' : ''}`}>
            <IconSprite />

            <nav className="rail" aria-label="Разделы системы">
                <div className="rail-head">
                    <button
                        className="rail-burger"
                        onClick={() => setNarrow(v => !v)}
                        aria-label={narrow ? 'Развернуть панель' : 'Свернуть панель'}
                    >
                        <Icon name="menu" size={20} />
                    </button>
                    <div className="rail-wordmark">
                        <b>Видеоаналитика</b>
                        <span>ВНИИЖТ</span>
                    </div>
                </div>

                <div className="rail-nav">
                    {NAV.map(item => (
                        <div key={item.to} style={{ display: 'contents' }}>
                            {item.group && <div className="rail-group">{item.group}</div>}
                            {item.ready ? (
                                <NavLink
                                    to={item.to}
                                    end={item.to === '/'}
                                    className={({ isActive }) => `rail-item${isActive ? ' is-active' : ''}`}
                                >
                                    <Icon name={item.icon} />
                                    <span className="lbl">{item.label}</span>
                                </NavLink>
                            ) : (
                                <div className="rail-item is-pending" aria-disabled="true">
                                    <Icon name={item.icon} />
                                    <span className="lbl">{item.label}</span>
                                    <span className="badge">в работе</span>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                <div className="rail-foot">
                    <div className="avatar">{initials}</div>
                    <div className="who">
                        <b>{username || 'Оператор'}</b>
                        <span>{role === 'admin' ? 'Администратор' : 'Наблюдатель'}</span>
                    </div>
                    <button className="rail-exit" onClick={onLogout} title="Выйти" aria-label="Выйти">
                        <Icon name="exit" size={16} />
                    </button>
                </div>
            </nav>

            <div className="main">
                <header className="topbar">
                    <div className="crumbs">
                        {crumbs.map((part, i) => (
                            <span key={part} style={{ display: 'contents' }}>
                                {i > 0 && <Icon name="chev" size={12} />}
                                <span className={i === crumbs.length - 1 ? 'cur' : 'up'}>{part}</span>
                            </span>
                        ))}
                    </div>

                    <div className="top-right">
                        <DownloadsPill />
                        <span className={`pill ${connected ? 'ok' : 'err'}`}>
                            <span className="dot" />
                            {connected ? 'связь' : 'нет связи'}
                        </span>
                        <span className="pill">
                            <span className="dot" style={{ background: 'var(--acc)' }} />
                            {cameras.length} камер
                        </span>
                        {offlineDevices > 0 && (
                            <span className="pill err">
                                <span className="dot" />
                                {offlineDevices} устр. не в сети
                            </span>
                        )}
                        <span
                            className={`pill num${source === 'can' ? '' : ' is-dim'}`}
                            title={source === 'can' ? 'Время изделия' : 'Время сервера, шина молчит'}
                        >
                            {formatDeviceTime(unixMs)}
                        </span>
                    </div>
                </header>

                <div className="stage">
                    <Outlet />
                </div>
            </div>
        </div>
    );
}
