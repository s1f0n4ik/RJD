import React, { useState, useEffect } from 'react';
import { Box } from '@mui/material';
import Header from './components/Header';
import Dashboard from './components/Dashboard';
import CameraSettings from './components/CameraSettings';
import LoaderSettings from './components/LoaderSettings';
import SystemStatus from './components/SystemStatus';
import Login from './components/Login';
import { wsService } from './services/websocket';
import type { SystemState } from './types';

const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [state, setState] = useState<SystemState>({
    cameras: [],
    loaders: [],
  });

  // ✅ ДОБАВЛЕНО: Auth state
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [role, setRole] = useState<string | null>(localStorage.getItem('role'));
  const [username, setUsername] = useState<string | null>(localStorage.getItem('username'));

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
    setRole(null);
    setUsername(null);
  };

  useEffect(() => {
    if (token) {
      wsService.connect(
        (newState) => setState(newState),
        (connected) => setWsConnected(connected)
      );
    }

    return () => {
      wsService.disconnect();
    };
  }, [token]);

  // ✅ Показать Login, если не авторизован
  if (!token) {
    return <Login onLogin={handleLogin} />;
  }

  const renderContent = () => {
    switch (currentTab) {
      case 0:
        return <Dashboard state={state} />;
      case 1:
        return role === 'admin' ? <CameraSettings /> : <div>Доступ запрещён</div>;
      case 2:
        return role === 'admin' ? <LoaderSettings /> : <div>Доступ запрещён</div>;
      case 3:
        return <SystemStatus />;
      default:
        return <Dashboard state={state} />;
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#f5f5f5' }}>
      <Header
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        wsConnected={wsConnected}
        role={role || 'viewer'}
        username={username || ''}
        onLogout={handleLogout}
      />
      <Box sx={{ py: 4 }}>{renderContent()}</Box>
    </Box>
  );
};

export default App;