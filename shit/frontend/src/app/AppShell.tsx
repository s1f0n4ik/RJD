import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon, IconSprite } from './Icons';
import { crumbsFor } from './nav';
import { canOpen, navFor } from './role';
import { DownloadsPill } from './DownloadsPill';
import { useSystem } from './SystemContext';
import { ToastProvider } from './Toast';
import { formatDeviceTime, useDeviceClock } from './useDeviceClock';
import { useSurroundStatus, type SurroundStatus } from './surroundStatus';
import './shell.css';

// Точка состояния у подраздела: поток калибровки идёт, вывод в эфире
function subDot(to: string, status: SurroundStatus) {
    if (to === '/surround/calibration' && status.streaming) return <span className="dot ok" />;
    if (to === '/surround/linker' && status.live) return <span className="dot ok" />;
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

    const offlineDevices = devices.filter(d => d.status !== 'online').length;
    const crumbs = crumbsFor(pathname);
    const initials = username.slice(0, 2).toUpperCase() || 'ОП';
    const nav = navFor(role);

    const navRef = useRef<HTMLDivElement>(null);
    const indRef = useRef<HTMLElement>(null);
    const indPlaced = useRef(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const firstPath = useRef(true);

    // Планка раздела переезжает к активному пункту; первая расстановка без анимации
    useLayoutEffect(() => {
        const ind = indRef.current;
        const active = navRef.current?.querySelector<HTMLElement>('.rail-item.is-active');
        if (!ind) return;
        if (!active) {
            ind.style.opacity = '0';
            return;
        }
        if (!indPlaced.current) ind.style.transition = 'none';
        ind.style.opacity = '1';
        ind.style.height = `${active.offsetHeight - 16}px`;
        ind.style.transform = `translateY(${active.offsetTop + 8}px)`;
        if (!indPlaced.current) {
            void ind.offsetHeight;
            ind.style.transition = '';
            indPlaced.current = true;
        }
    }, [pathname, narrow, nav.length]);

    // Смена экрана: новый экран проявляется со сдвигом 4 px
    useLayoutEffect(() => {
        if (firstPath.current) {
            firstPath.current = false;
            return;
        }
        const screen = stageRef.current?.firstElementChild;
        if (!screen || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        screen.animate(
            [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
            { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
    }, [pathname]);

    // Закрытый для роли адрес — на главную; проверка одна на все экраны
    if (!canOpen(pathname, role)) return <Navigate to="/" replace />;

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
                            {subDot(sub.to, surround)}
                        </NavLink>
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <ToastProvider>
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

                    <div className="rail-nav" ref={navRef}>
                        <i className="rail-ind" ref={indRef} />
                        {nav.map((item, i) => (
                            <Fragment key={item.to}>
                                {item.group && item.group !== nav[i - 1]?.group && <div className="rail-group">{item.group}</div>}
                                {railItem(item)}
                                {/* Эфир замыкает «Видео» и открывается вне оболочки — обычная ссылка, не маршрут роутера */}
                                {item.group === 'Видео' && nav[i + 1]?.group !== 'Видео' && (
                                    <a className="rail-item" href="/translation">
                                        <Icon name="play" />
                                        <span className="lbl">Прямая трансляция</span>
                                    </a>
                                )}
                            </Fragment>
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
                            <a className="icon-btn top-live" href="/translation" data-tip="Прямая трансляция" aria-label="Прямая трансляция">
                                <Icon name="play" size={13} />
                            </a>
                        </div>
                    </header>

                    <div className="stage" ref={stageRef}>
                        <Outlet />
                    </div>
                </div>
            </div>
        </ToastProvider>
    );
}
