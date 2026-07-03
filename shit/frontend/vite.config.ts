import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// IP оранжпи с C++ Media Center (dev-режим).
// В проде прокси не нужен — работает nginx.
const DEV_BACKEND = 'http://192.168.1.2';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    proxy: {
      '/neural': { target: DEV_BACKEND, changeOrigin: true },
      '/api':    { target: DEV_BACKEND, changeOrigin: true },
      '/auth':   { target: DEV_BACKEND, changeOrigin: true },
      // если WebSocket-сигналинг тоже ходит через тот же origin — добавь ws:
      // '/ws': { target: DEV_BACKEND, changeOrigin: true, ws: true },
    },
  },
});