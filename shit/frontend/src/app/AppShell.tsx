import { useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon, IconSprite } from './Icons';
import { crumbsFor } from './nav';
import { canOpen, navFor } from './role';
import { DownloadsPill } from './DownloadsPill';
import { useSystem } from './SystemContext';
import { formatDeviceTime, useDeviceClock } from './useDeviceClock';
import { useSurroundStatus, type SurroundStatus } from './surroundStatus';
import { useNeuralStatus, type NeuralStatus } from './neuralStatus';
import './shell.css';

// Точка состояния у подраздела: поток калибровки идёт, вывод в эфире, слоты нейронки работают или упали
function subDot(to: string, status: SurroundStatus, neural: NeuralStatus) {
    if (to === '/surround/calibration' && status.streaming) return <span className="dot ok" />;
    if (to === '/surround/linker' && status.live) return <span className="dot ok" />;
    if (to === '/neural/streams' && neural.failed) return <span className="dot err" />;
    if (to === '/neural/streams' && neural.running) return <span className="dot ok" />;
    return null;
}

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
    const surround = useSurroundStatus();
    const neural = useNeuralStatus();

    const offlineDevices = devices.filter(d => d.status !== 'online').length;
    const crumbs = crumbsFor(pathname);
    const initials = username.slice(0, 2).toUpperCase() || 'ОП';

    // Закрытый для роли адрес — на главную; проверка одна на все экраны
    if (!canOpen(pathname, role)) return <Navigate to="/" replace />;

    // Подпись группы стоит у первого модуля, всё после него — та же группа
    const nav = navFor(role);
    const firstModule = nav.findIndex(item => item.group);
    const mainItems = firstModule < 0 ? nav : nav.slice(0, firstModule);
    const moduleItems = firstModule < 0 ? [] : nav.slice(firstModule);

    const railItem = (item: (typeof nav)[number]) => (
        <div key={item.to} style={{ display: 'contents' }}>
            <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `rail-item${isActive ? ' is-active' : ''}`}
            >
                <Icon name={item.icon} />
                <span className="lbl">{item.label}</span>
            </NavLink>
            {item.sub && (
                <div className="rail-sub">
                    {item.sub.map(sub => (
                        <NavLink key={sub.to} to={sub.to} className={({ isActive }) => `rsub${isActive ? ' is-on' : ''}`}>
                            <span className="n">{sub.n}</span>
                            {sub.label}
                            {subDot(sub.to, surround, neural)}
                        </NavLink>
                    ))}
                </div>
            )}
        </div>
    );

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
                    {mainItems.map(railItem)}
                    {/* Эфир открывается вне оболочки — обычная ссылка, не маршрут роутера */}
                    <a className="rail-item" href="/translation">
                        <Icon name="play" />
                        <span className="lbl">Прямая трансляция</span>
                    </a>
                    {moduleItems.length > 0 && <div className="rail-group">{moduleItems[0].group}</div>}
                    {moduleItems.map(railItem)}
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
                        <a className="icon-btn top-live" href="/translation" data-tip="Прямая трансляция" aria-label="Прямая трансляция">
                            <Icon name="play" size={13} />
                        </a>
                    </div>
                </header>

                <div className="stage">
                    <Outlet />
                </div>
            </div>
        </div>
    );
}
