import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import App from './App';
import { rzdTheme } from './theme';
import { loadDevices } from './services/devices';

// Таблица маршрутизации нужна до первого обращения к устройствам
loadDevices()
  .catch((e) => console.error('Не удалось загрузить реестр устройств:', e))
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeProvider theme={rzdTheme}>
          <CssBaseline />
          <App />
        </ThemeProvider>
      </React.StrictMode>
    );
  });