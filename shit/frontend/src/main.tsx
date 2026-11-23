import React, { Suspense, lazy, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
// Общие слои CSS — до компонентов экранов, иначе экранные правила проигрывают базовым
import './styles/tokens.css';
import './styles/ui.css';
import './screens/login/login.css';
import { Bootstrap } from './app/Bootstrap';
import { TipLayer } from './app/TipLayer';
import { OnScreenKeyboard } from './app/OnScreenKeyboard';
import { LoginScreen } from './screens/login/LoginScreen';
import { FULL_AUTH, readStoredToken } from './utils/auth';

// Оболочка и эфир — разные чанки: на изделии автозапуск открывает только эфир
const NewApp = lazy(() => import('./app/NewApp'));
const TranslationScreen = lazy(() => import('./screens/translation/TranslationScreen'));
const KztScreen = lazy(() => import('./screens/kzt/KztScreen'));

// Сколько «/» ждёт ответа шлюза при загрузке изделия, прежде чем уйти в эфир
const ROOT_WAIT_MS = 20_000;
const ROOT_RETRY_MS = 2_000;

// «/» на изделии: при активной конфигурации КЖТ — экран КЖТ, иначе эфир
function RootRedirect() {
    useEffect(() => {
        let alive = true;
        const started = Date.now();
        const attempt = async () => {
            try {
                const res = await fetch('/api/configurations/gateway/status');
                if (res.ok) {
                    const body = await res.json();
                    if (alive) window.location.replace(body?.id === 'kzt' ? '/kzt' : '/translation');
                    return;
                }
            } catch {
                // Шлюз ещё поднимается
            }
            if (!alive) return;
            if (Date.now() - started > ROOT_WAIT_MS) window.location.replace('/translation');
            else window.setTimeout(attempt, ROOT_RETRY_MS);
        };
        attempt();
        return () => { alive = false; };
    }, []);
    return bootVeil;
}

// Тот же экран, что и сплэш в index.html: ленивый чанк грузится уже после того,
// как Bootstrap снял #boot, и пустой fallback давал бы белый кадр
const bootVeil = (
    <div className="boot">
        <div className="boot-mark">Видеоаналитика</div>
        <div className="boot-bar" />
    </div>
);

/**
 * Развилка по адресу. Роутер живёт внутри оболочки на /app; эфир /translation —
 * отдельный экран без логина (на изделии сюда приходит автозапуск браузера).
 */
function Entry() {
    const { pathname, search, hash } = window.location;
    const [token, setToken] = useState<string | null>(readStoredToken());

    // Прежние адреса: /new — оболочка до переезда, /kiosk — эфир до переименования
    if (pathname.startsWith('/new')) {
        window.location.replace(`/app${pathname.slice('/new'.length)}${search}${hash}`);
        return null;
    }
    if (pathname.startsWith('/kiosk')) {
        window.location.replace(`/translation${pathname.slice('/kiosk'.length)}${search}${hash}`);
        return null;
    }

    // Защищённая сборка: логин требуется до любого маршрута, включая / и /translation
    if (FULL_AUTH && !token) {
        return (
            <>
                <LoginScreen
                    onLogin={(t, role, username) => {
                        localStorage.setItem('token', t);
                        localStorage.setItem('role', role);
                        localStorage.setItem('username', username);
                        setToken(t);
                    }}
                />
                <OnScreenKeyboard />
            </>
        );
    }

    if (pathname.startsWith('/translation')) {
        return (
            <Suspense fallback={bootVeil}>
                <TranslationScreen />
            </Suspense>
        );
    }

    if (pathname.startsWith('/kzt')) {
        return (
            <Suspense fallback={bootVeil}>
                <KztScreen />
            </Suspense>
        );
    }

    if (pathname.startsWith('/app')) {
        return (
            <Suspense fallback={bootVeil}>
                <NewApp />
            </Suspense>
        );
    }

    // Без FULL_AUTH «/» — эфир или экран КЖТ; с FULL_AUTH сюда доходят уже с токеном
    if (!FULL_AUTH) return <RootRedirect />;
    window.location.replace('/app');
    return null;
}

// Реестр устройств грузит Bootstrap: монтирование его больше не ждёт
ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <Bootstrap>
            <Entry />
            <TipLayer />
        </Bootstrap>
    </React.StrictMode>
);
