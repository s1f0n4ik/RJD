import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
// Токены и общие классы обязаны попасть в документ раньше стилей экранов:
// иначе базовое .modal из ui.css перебивает экранные размеры модалок
import '../styles/tokens.css';
import '../styles/ui.css';
import { AppShell } from './AppShell';
import { SystemProvider } from './SystemContext';
import { HomeScreen } from '../screens/home/HomeScreen';
import { CamerasScreen } from '../screens/cameras/CamerasScreen';
import LiveScreen from '../screens/live/LiveScreen';
import { LoginScreen } from '../screens/login/LoginScreen';
import { readStoredToken } from '../utils/auth';

/**
 * Новая оболочка на /new. Живёт рядом со старым приложением на /app и
 * подключается лениво — пока сюда не зашли, её стили не попадают в документ
 * и не спорят с MUI-темой старых экранов.
 */
export default function NewApp() {
    const [token, setToken] = useState<string | null>(readStoredToken());
    const [role, setRole] = useState<string>(localStorage.getItem('role') ?? 'viewer');
    const [username, setUsername] = useState<string>(localStorage.getItem('username') ?? '');

    // Базовые правила макета прижаты к body.ui-new, иначе они задели бы /app
    useEffect(() => {
        document.body.classList.add('ui-new');
        return () => document.body.classList.remove('ui-new');
    }, []);

    const handleLogin = (newToken: string, newRole: string, newUsername: string) => {
        localStorage.setItem('token', newToken);
        localStorage.setItem('role', newRole);
        localStorage.setItem('username', newUsername);
        setToken(newToken);
        setRole(newRole);
        setUsername(newUsername);
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('role');
        localStorage.removeItem('username');
        setToken(null);
    };

    if (!token) return <LoginScreen onLogin={handleLogin} />;

    return (
        <BrowserRouter basename="/new">
            <SystemProvider>
                <Routes>
                    <Route element={<AppShell username={username} role={role} onLogout={handleLogout} />}>
                        <Route index element={<HomeScreen />} />
                        <Route path="cameras" element={<CamerasScreen />} />
                        <Route path="live" element={<LiveScreen />} />
                        {/* Непереписанные разделы адресов ещё не имеют: любой другой путь ведёт на главную */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Route>
                </Routes>
            </SystemProvider>
        </BrowserRouter>
    );
}
