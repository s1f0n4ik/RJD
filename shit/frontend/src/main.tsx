import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import App from './App';
import { rzdTheme } from './theme';
import { Bootstrap } from './components/Bootstrap';

// Реестр устройств грузит Bootstrap: монтирование его больше не ждёт
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={rzdTheme}>
      <CssBaseline />
      <Bootstrap>
        <App />
      </Bootstrap>
    </ThemeProvider>
  </React.StrictMode>
);
