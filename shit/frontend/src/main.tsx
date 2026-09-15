import React, { Suspense, lazy, useState } from 'react';
import ReactDOM from 'react-dom/client';
// Общие слои CSS — до компонентов экранов, иначе экранные правила проигрывают базовым
import './styles/tokens.css';
import './styles/ui.css';
import './screens/login/login.css';
import { Bootstrap } from './app/Bootstrap';
import { OnScreenKeyboard } from './app/OnScreenKeyboard';
import { LoginScreen } from './screens/login/LoginScreen';
import { FULL_AUTH, readStoredToken } from './utils/auth';

// Оболочка и эфир — разные чанки: на изделии автозапуск открывает только эфир
const NewApp = lazy(() => import('./app/NewApp'));
const TranslationScreen = lazy(() => import('./screens/translation/TranslationScreen'));

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

    if (pathname.startsWith('/app')) {
        return (
            <Suspense fallback={bootVeil}>
                <NewApp />
            </Suspense>
        );
    }

    // Без FULL_AUTH «/» — это эфир; с FULL_AUTH сюда доходят уже с токеном
    window.location.replace(FULL_AUTH ? '/app' : '/translation');
    return null;
}

// Реестр устройств грузит Bootstrap: монтирование его больше не ждёт
ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <Bootstrap>
            <Entry />
        </Bootstrap>
    </React.StrictMode>
);
