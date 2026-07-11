import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Container, Snackbar, Alert } from '@mui/material';
import TopBar from './TopBar';
import type { KrspsView } from './TopBar';
import ModuleRail, { TIME_SECTION } from './ModuleRail';
import WebSocketModulePanel from './WebSocketModulePanel';
import TimeGpsPanel from './TimeGpsPanel';
import ConfigCards from './ConfigCards';
import { krspsApi } from '../api/client';
import type { GwIntegrations, GwStatus, GwTime, GwWsConfigPatch } from '../types';
import { SOFT } from '../ui';

const STATUS_POLL_MS = 2000;
const TIME_POLL_MS = 5000;

const KrspsApp: React.FC = () => {
  const [view, setView] = useState<KrspsView>('modules');
  const [selected, setSelected] = useState<string>('');
  const [status, setStatus] = useState<GwStatus | null>(null);
  const [integrations, setIntegrations] = useState<GwIntegrations | null>(null);
  const [time, setTime] = useState<GwTime | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [synced, setSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; sev: 'success' | 'error' | 'info' } | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Держим выбранный раздел валидным: модуль из активной конфигурации или «Время и GPS».
  useEffect(() => {
    if (!status) return;
    const ids = status.modules.map((m) => m.id);
    if (selected === TIME_SECTION) return;
    if (!ids.includes(selected)) {
      setSelected(ids[0] ?? TIME_SECTION);
    }
  }, [status, selected]);

  const refreshIntegrations = useCallback(async () => {
    try {
      const ints = await krspsApi.getIntegrations();
      if (alive.current) setIntegrations(ints);
    } catch {
      /* индикатор соединения покажет проблему */
    }
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await krspsApi.getStatus();
        if (!stop && alive.current) setStatus(s);
      } catch {
        if (!stop && alive.current) setStatus(null);
      }
    };
    tick();
    const t = setInterval(tick, STATUS_POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const t = await krspsApi.getTime();
        if (!stop && alive.current) {
          setTime(t);
          setOffsetMs(t.unix_ms - Date.now());
          setSynced(true);
        }
      } catch {
        /* некритично — таймер продолжит идти локально */
      }
    };
    tick();
    const t = setInterval(tick, TIME_POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    refreshIntegrations();
  }, [refreshIntegrations]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, okMsg: string) => {
      setBusy(true);
      try {
        await fn();
        const s = await krspsApi.getStatus().catch(() => null);
        if (alive.current && s) setStatus(s);
        await refreshIntegrations();
        if (alive.current) setToast({ msg: okMsg, sev: 'success' });
      } catch (e: any) {
        if (alive.current) setToast({ msg: e?.message ?? 'Ошибка запроса', sev: 'error' });
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [refreshIntegrations],
  );

  const handleSelectConfig = (id: string) =>
    run(async () => {
      await krspsApi.selectIntegration(id);
      if (alive.current) setView('modules');
    }, 'Конфигурация переключена');
  const handleSave = (patch: GwWsConfigPatch) => run(() => krspsApi.updateWsConfig(patch), 'Настройки сохранены');
  const handleConnect = () => run(() => krspsApi.connect(), 'Переподключение запущено');
  const handleDisconnect = () => run(() => krspsApi.disconnect(), 'Соединение закрыто');

  const activeTitle =
    status?.title ??
    integrations?.items.find((i) => i.id === integrations?.active)?.title ??
    '—';

  const selectedModule = status?.modules.find((m) => m.id === selected) ?? null;

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: SOFT.bg }}>
      <TopBar
        configTitle={activeTitle}
        view={view}
        onOpenConfigs={() => setView('configs')}
        onBackToModules={() => setView('modules')}
      />

      <Container maxWidth="xl" sx={{ py: 3 }}>
        {view === 'configs' ? (
          <ConfigCards
            integrations={integrations}
            busy={busy}
            onSelect={handleSelectConfig}
            onOpenModules={() => setView('modules')}
          />
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '236px minmax(0, 1fr)' },
              gap: 2.5,
              alignItems: 'start',
            }}
          >
            <ModuleRail modules={status?.modules ?? []} selected={selected} onSelect={setSelected} />
            <Box sx={{ minWidth: 0 }}>
              {selected === TIME_SECTION ? (
                <TimeGpsPanel time={time} offsetMs={offsetMs} synced={synced} />
              ) : selectedModule ? (
                <WebSocketModulePanel
                  module={selectedModule}
                  busy={busy}
                  onSave={handleSave}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                />
              ) : (
                <Box sx={{ py: 8, textAlign: 'center', color: SOFT.mute, fontSize: '0.9rem' }}>
                  Загрузка состояния шлюза…
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Container>

      <Snackbar
        open={!!toast}
        autoHideDuration={3500}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.sev} onClose={() => setToast(null)} variant="filled">
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
};

export default KrspsApp;
