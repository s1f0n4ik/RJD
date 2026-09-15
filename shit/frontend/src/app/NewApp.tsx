import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';
import { DownloadsProvider } from './DownloadsContext';
import { OnScreenKeyboard } from './OnScreenKeyboard';
import { RoleContext } from './role';
import { SystemProvider } from './SystemContext';
import { HomeScreen } from '../screens/home/HomeScreen';
import { CamerasScreen } from '../screens/cameras/CamerasScreen';
import LiveScreen from '../screens/live/LiveScreen';
import ArchiveScreen from '../screens/archive/ArchiveScreen';
import { DevicesScreen } from '../screens/devices/DevicesScreen';
import KrspsScreen from '../screens/krsps/KrspsScreen';
import SurroundScreen from '../screens/surround/SurroundScreen';
import NeuralScreen from '../screens/neural/NeuralScreen';
import { LoginScreen } from '../screens/login/LoginScreen';
import { readStoredToken } from '../utils/auth';

// Прежний адрес модуля 360: остался в закладках и в документации
function BirdviewRedirect() {
    const { pathname } = useLocation();
    return <Navigate to={pathname.replace(/^\/birdview/, '/surround')} replace />;
}

/** Оболочка приложения на /app: логин, разделы, права по роли. */
export default function NewApp() {
    const [token, setToken] = useState<string | null>(readStoredToken());
    const [role, setRole] = useState<string>(localStorage.getItem('role') ?? 'viewer');
    const [username, setUsername] = useState<string>(localStorage.getItem('username') ?? '');

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

    if (!token) {
        return (
            <>
                <LoginScreen onLogin={handleLogin} />
                <OnScreenKeyboard />
            </>
        );
    }

    return (
        <BrowserRouter basename="/app">
            <RoleContext.Provider value={role}>
            <SystemProvider>
                <DownloadsProvider>
                <Routes>
                    <Route element={<AppShell username={username} role={role} onLogout={handleLogout} />}>
                        <Route index element={<HomeScreen />} />
                        <Route path="cameras" element={<CamerasScreen />} />
                        <Route path="live" element={<LiveScreen />} />
                        <Route path="archive" element={<ArchiveScreen />} />
                        <Route path="devices" element={<DevicesScreen />} />
                        <Route path="krsps" element={<KrspsScreen />} />
                        <Route path="krsps/:section" element={<KrspsScreen />} />
                        <Route path="surround" element={<SurroundScreen />} />
                        <Route path="surround/:section" element={<SurroundScreen />} />
                        <Route path="birdview/*" element={<BirdviewRedirect />} />
                        <Route path="neural" element={<NeuralScreen />} />
                        <Route path="neural/:section" element={<NeuralScreen />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Route>
                </Routes>
                </DownloadsProvider>
            </SystemProvider>
            </RoleContext.Provider>
            <OnScreenKeyboard />
        </BrowserRouter>
    );
}
