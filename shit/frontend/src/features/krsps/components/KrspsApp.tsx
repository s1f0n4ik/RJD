import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../styles/theme.css';
import TopBar from './TopBar';
import type { KrspsView } from './TopBar';
import ModuleRail, { TAXONOMY_SECTION, TIME_SECTION } from './ModuleRail';
import WebSocketModulePanel from './WebSocketModulePanel';
import CanModulePanel from './CanModulePanel';
import TaxonomyPanel from './TaxonomyPanel';
import TimeGpsPanel from './TimeGpsPanel';
import ConfigCards from './ConfigCards';
import { krspsApi } from '../api/client';
import type {
  GwCanConfigPatch,
  GwIntegrations,
  GwStatus,
  GwTaxonomy,
  GwTaxonomyPatch,
  GwTime,
  GwWsConfigPatch,
} from '../types';

const STATUS_POLL_MS = 2000;
const TIME_POLL_MS = 5000;

type Toast = { msg: string; sev: 'success' | 'error' | 'info' };

const KrspsApp: React.FC = () => {
  const [view, setView] = useState<KrspsView>('modules');
  const [selected, setSelected] = useState<string>('');
  const [status, setStatus] = useState<GwStatus | null>(null);
  const [integrations, setIntegrations] = useState<GwIntegrations | null>(null);
  const [taxonomy, setTaxonomy] = useState<GwTaxonomy | null>(null);
  const [time, setTime] = useState<GwTime | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [synced, setSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Автоскрытие тоста.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Держим выбранный раздел валидным: модуль активной конфигурации либо общий
  // раздел сервиса.
  useEffect(() => {
    if (!status) return;
    if (selected === TIME_SECTION || selected === TAXONOMY_SECTION) return;
    const ids = status.modules.map((m) => m.id);
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

  const refreshTaxonomy = useCallback(async () => {
    try {
      const t = await krspsApi.getTaxonomy();
      if (alive.current) setTaxonomy(t);
    } catch {
      /* раздел покажет «Загрузка…»; статус шлюза виден по индикатору */
    }
  }, []);

  useEffect(() => {
    refreshIntegrations();
    refreshTaxonomy();
  }, [refreshIntegrations, refreshTaxonomy]);

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
  const handleSaveWs = (patch: GwWsConfigPatch) => run(() => krspsApi.updateWsConfig(patch), 'Настройки сохранены');
  const handleSaveCan = (patch: GwCanConfigPatch) => run(() => krspsApi.updateCanConfig(patch), 'Настройки сохранены');
  const handleSaveTaxonomy = (patch: GwTaxonomyPatch) =>
    run(async () => {
      const t = await krspsApi.updateTaxonomy(patch);
      if (alive.current) setTaxonomy(t);
    }, 'Таблица сохранена');

  // Подключение адресное: у конфигурации несколько модулей, и трогать нужно
  // только тот, что открыт на странице.
  const handleConnect = () => run(() => krspsApi.connectModule(selected), 'Переподключение запущено');
  const handleDisconnect = () => run(() => krspsApi.disconnectModule(selected), 'Соединение закрыто');

  const activeTitle =
    status?.title ??
    integrations?.items.find((i) => i.id === integrations?.active)?.title ??
    '—';

  const selectedModule = status?.modules.find((m) => m.id === selected) ?? null;

  return (
    <div className="krsps-root">
      <TopBar
        configTitle={activeTitle}
        view={view}
        onOpenConfigs={() => setView('configs')}
        onBackToModules={() => setView('modules')}
      />

      <div className="krsps-container">
        {view === 'configs' ? (
          <ConfigCards
            integrations={integrations}
            busy={busy}
            onSelect={handleSelectConfig}
            onOpenModules={() => setView('modules')}
          />
        ) : (
          <div className="krsps-layout">
            <ModuleRail modules={status?.modules ?? []} selected={selected} onSelect={setSelected} />
            <div style={{ minWidth: 0 }}>
              {selected === TIME_SECTION ? (
                <TimeGpsPanel time={time} offsetMs={offsetMs} synced={synced} />
              ) : selected === TAXONOMY_SECTION ? (
                <TaxonomyPanel taxonomy={taxonomy} busy={busy} onSave={handleSaveTaxonomy} />
              ) : selectedModule?.transport === 'can' ? (
                <CanModulePanel
                  module={selectedModule}
                  busy={busy}
                  onSave={handleSaveCan}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                />
              ) : selectedModule ? (
                <WebSocketModulePanel
                  module={selectedModule}
                  busy={busy}
                  onSave={handleSaveWs}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                />
              ) : (
                <div className="krsps-empty">Загрузка состояния шлюза…</div>
              )}
            </div>
          </div>
        )}
      </div>

      {toast && <div className={`krsps-toast krsps-toast--${toast.sev}`}>{toast.msg}</div>}
    </div>
  );
};

export default KrspsApp;
