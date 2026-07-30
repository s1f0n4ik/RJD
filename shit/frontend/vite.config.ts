import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// IP оранжпи с C++ Media Center (dev-режим).
// В проде прокси не нужен — работает nginx.
const DEV_BACKEND = 'http://192.168.1.102';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    proxy: {
      // ws:true — под /d живут сигналинг и прогресс-сокет склейки
      '/d':         { target: DEV_BACKEND, changeOrigin: true, ws: true },
      '/neural':    { target: DEV_BACKEND, changeOrigin: true },
      // ws:true — под /api живёт прогресс-сокет склейки
      // /api/recordings/jobs/{id}/progress, без него панель зависает в ожидании.
      '/api':       { target: DEV_BACKEND, changeOrigin: true, ws: true },
      '/auth':      { target: DEV_BACKEND, changeOrigin: true },
      '/linker':    { target: DEV_BACKEND, changeOrigin: true },
      '/ws':        { target: DEV_BACKEND, changeOrigin: true, ws: true },
      '/signaling': { target: DEV_BACKEND, changeOrigin: true, ws: true },
    },
  },
});