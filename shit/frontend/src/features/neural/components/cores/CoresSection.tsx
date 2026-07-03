import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { neuralApi } from '../../api/client';
import { NPU_CORES } from '../../api/types';
import type {
  ActiveDesc,
  CameraMatrix,
  CameraStreamInfo,
  ConfigSummary,
  CoreId,
  SlotStatus,
} from '../../api/types';
import { CoreCard } from './CoreCard';

type Mode = 'view' | 'edit';
type DropMode = 'move' | 'copy';
type DragKind = 'core' | 'list' | null;
export interface CamOption { id: string; name: string; resolution?: string }

/**
 * Слот = один конфиг + одна матрица камер, работающий на наборе NPU-ядер.
 * Несколько ядер в одном слоте — это параллелизм одного слота (cores:[0,1]).
 * Один и тот же config_id в разных слотах с разными камерами — разные слоты.
 */
interface Slot {
  configId: string;
  cameras: CameraMatrix;
  cores: CoreId[];
}

const isCore = (c: number): c is CoreId => (NPU_CORES as readonly number[]).includes(c);
const clone = (s: Slot[]): Slot[] => s.map((x) => ({ ...x, cameras: x.cameras.map((r) => [...r]), cores: [...x.cores] }));
const slotKey = (configId: string, cameras: CameraMatrix) => configId + '|' + JSON.stringify(cameras);

function slotsFromDescs(descs: ActiveDesc[]): Slot[] {
  return descs
    .map((d) => ({ configId: d.config_id, cameras: d.camera_matrix ?? [], cores: (d.cores ?? []).filter(isCore) }))
    .filter((s) => s.cores.length > 0);
}

/** core → подпись слота (config + камеры), для подсветки изменений. */
function coreSig(slots: Slot[]): Record<CoreId, string | null> {
  const m: Record<CoreId, string | null> = { 0: null, 1: null, 2: null };
  for (const s of slots) for (const c of s.cores) m[c] = slotKey(s.configId, s.cameras);
  return m;
}

/** Разрешение основного потока — берём поток с наибольшим разрешением. */
function mainResolution(streams?: Record<string, CameraStreamInfo>): string | undefined {
  if (!streams) return undefined;
  let best: CameraStreamInfo | null = null;
  for (const s of Object.values(streams)) {
    if (!s.width || !s.height) continue;
    if (!best || s.width * s.height > best.width! * best.height!) best = s;
  }
  return best ? `${best.width}×${best.height}` : undefined;
}

export function CoresSection() {
  const [mode, setMode] = useState<Mode>('view');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [savedSlots, setSavedSlots] = useState<Slot[]>([]);
  const [available, setAvailable] = useState<ConfigSummary[]>([]);
  const [status, setStatus] = useState<SlotStatus[]>([]);
  const [availableCameras, setAvailableCameras] = useState<CamOption[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dragKind, setDragKind] = useState<DragKind>(null);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgCooldown, setCfgCooldown] = useState(false);
  const [switchModal, setSwitchModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dragSource = useRef<{ configId: string; sourceCoreId: CoreId | null } | null>(null);

  // ── загрузка ───────────────────────────────────────────────
  const loadState = useCallback(async () => {
    const [descs, cfgs] = await Promise.all([
      neuralApi.getState(),
      neuralApi.listConfigurations().then((r) => r.configurations).catch(() => [] as ConfigSummary[]),
    ]);
    const s = slotsFromDescs(descs);
    setSlots(clone(s));
    setSavedSlots(clone(s));
    setAvailable(cfgs);
  }, []);

  const loadCameras = useCallback(async () => {
    try {
      const res = await neuralApi.listCameras();
      if (res.cameras) {
        const cams = Object.entries(res.cameras)
          .filter(([, v]) => (v.type ?? v.camera_type) === 2)
          .map(([id, v]) => ({ id, name: v.display_name ?? id, resolution: mainResolution(v.streams) }));
        setAvailableCameras(cams);
      }
    } catch {
      // сервер недоступен — список камер останется пустым
    }
  }, []);

  const loadStatus = useCallback(() => {
    neuralApi.getStatus().then(setStatus).catch(() => setStatus([]));
  }, []);

  useEffect(() => {
    loadState();
    loadCameras();
    loadStatus();
    const t = setInterval(loadStatus, 3000);
    return () => clearInterval(t);
  }, [loadState, loadCameras, loadStatus]);

  // глобальный конец перетаскивания
  useEffect(() => {
    const end = () => { setDragging(false); setDragKind(null); };
    document.addEventListener('dragend', end);
    return () => document.removeEventListener('dragend', end);
  }, []);

  // ── обновление списка конфигураций ─────────────────────────
  async function refreshConfigs() {
    setCfgCooldown(true);
    setTimeout(() => setCfgCooldown(false), 2000);
    setCfgLoading(true);
    setErr(null);
    try {
      await Promise.all([loadState(), loadCameras()]);
    } finally {
      setCfgLoading(false);
    }
  }

  // ── производные ────────────────────────────────────────────
  const slotByCore = useMemo(() => {
    const m: Record<CoreId, Slot | undefined> = { 0: undefined, 1: undefined, 2: undefined };
    for (const s of slots) for (const c of s.cores) m[c] = s;
    return m;
  }, [slots]);

  // running по ключу слота (config + камеры)
  const runningKeys = useMemo(() => {
    const set = new Set<string>();
    for (const s of status) if (s.running) set.add(slotKey(s.config_id, s.camera_matrix ?? []));
    return set;
  }, [status]);
  const isSupervisorRunning = status.some((s) => s.running);

  // ядра, занятые каждым config_id (для индикатора в списке)
  const coresByConfigId = useMemo(() => {
    const m: Record<string, CoreId[]> = {};
    for (const s of slots) (m[s.configId] ??= []).push(...s.cores);
    for (const k of Object.keys(m)) m[k].sort();
    return m;
  }, [slots]);

  const curSig = useMemo(() => coreSig(slots), [slots]);
  const savedSig = useMemo(() => coreSig(savedSlots), [savedSlots]);
  const hasPendingChanges = NPU_CORES.some((c) => curSig[c] !== savedSig[c]);

  // ── операции над слотами ───────────────────────────────────
  const removeCore = (list: Slot[], core: CoreId): Slot[] =>
    list
      .map((s) => (s.cores.includes(core) ? { ...s, cores: s.cores.filter((c) => c !== core) } : s))
      .filter((s) => s.cores.length > 0);

  const startDrag = useCallback((configId: string, sourceCoreId: CoreId | null, kind: DragKind) => {
    dragSource.current = { configId, sourceCoreId };
    setTimeout(() => { setDragging(true); setDragKind(kind); }, 0);
  }, []);

  const finishDrag = () => { dragSource.current = null; setDragging(false); setDragKind(null); };

  const dropConfig = useCallback((targetCore: CoreId, configId: string, dropMode: DropMode) => {
    const src = dragSource.current;
    const srcCore = src?.sourceCoreId ?? null;

    setSlots((list) => {
      // источник — ядро
      if (srcCore != null) {
        if (srcCore === targetCore) return list; // на себя
        const srcSlot = list.find((s) => s.cores.includes(srcCore));
        if (!srcSlot) return list;
        if (dropMode === 'copy' && srcSlot.cores.includes(targetCore)) return list;

        let next = removeCore(list, targetCore);
        if (dropMode === 'copy') {
          // подключаем целевое ядро к слоту источника (параллелизм)
          next = next.map((s) =>
            s.cores.includes(srcCore) ? { ...s, cores: [...s.cores, targetCore].sort() } : s,
          );
        } else {
          // перемещаем размещение источника на целевое ядро
          next = next.map((s) =>
            s.cores.includes(srcCore)
              ? { ...s, cores: s.cores.map((c) => (c === srcCore ? targetCore : c)).sort() }
              : s,
          );
        }
        return next;
      }

      // источник — список конфигураций (только move): новый слот без камер
      const cfg = configId || src?.configId;
      if (!cfg) return list;
      const next = removeCore(list, targetCore);
      next.push({ configId: cfg, cameras: [], cores: [targetCore] });
      return next;
    });

    finishDrag();
  }, []);

  const removeFromCore = useCallback((core: CoreId) => {
    setSlots((list) => removeCore(list, core));
  }, []);

  const setCameras = useCallback((core: CoreId, matrix: CameraMatrix) => {
    setSlots((list) => list.map((s) => (s.cores.includes(core) ? { ...s, cameras: matrix } : s)));
  }, []);

  // задействовать все ядра для слота этого ядра
  const expandToAll = useCallback((core: CoreId) => {
    setSlots((list) => {
      const slot = list.find((s) => s.cores.includes(core));
      if (!slot) return list;
      return [{ configId: slot.configId, cameras: slot.cameras, cores: [0, 1, 2] }];
    });
  }, []);

  // камеры, занятые в других слотах (для уникальности)
  const excludedFor = useCallback(
    (core: CoreId): Set<string> => {
      const set = new Set<string>();
      for (const s of slots) {
        if (s.cores.includes(core)) continue;
        for (const row of s.cameras) for (const cam of row) set.add(cam);
      }
      return set;
    },
    [slots],
  );

  // ── сохранение ─────────────────────────────────────────────
  function buildDescs(): ActiveDesc[] {
    return slots.map((s) => ({
      config_id: s.configId,
      cores: [...s.cores],
      camera_matrix: s.cameras
        .map((row) => row.map((x) => x.trim()).filter(Boolean))
        .filter((row) => row.length > 0),
    }));
  }

  function validate(descs: ActiveDesc[]): string | null {
    for (const d of descs) {
      if (d.camera_matrix.length === 0) return `'${d.config_id}': не задана ни одна камера`;
    }
    return null;
  }

  async function saveState(): Promise<boolean> {
    const descs = buildDescs();
    const problem = validate(descs);
    if (problem) { setErr(problem); return false; }
    setBusy(true); setErr(null);
    try {
      await neuralApi.setState(descs);
      setSavedSlots(clone(slots));
      loadStatus();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function tryGoView() {
    if (hasPendingChanges) setSwitchModal(true);
    else setMode('view');
  }
  async function applyAndView() {
    if (await saveState()) { setSwitchModal(false); setMode('view'); }
  }
  function discardEdits() {
    setSlots(clone(savedSlots));
    setErr(null);
  }
  function discardAndView() {
    discardEdits();
    setSwitchModal(false);
    setMode('view');
  }

  async function control(action: 'start' | 'restart' | 'stop') {
    setBusy(true); setErr(null);
    try {
      await neuralApi[action]();
      loadStatus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const editable = mode === 'edit';

  return (
    <div className="cores-section">
      <div className="cores-layout">
        {/* ── Левая колонка: прокручиваемый список ядер ─────── */}
        <div className="cores-col">
          {NPU_CORES.map((core) => {
            const slot = slotByCore[core];
            const running = slot ? runningKeys.has(slotKey(slot.configId, slot.cameras)) : false;
            return (
              <CoreCard
                key={core}
                coreId={core}
                configId={slot?.configId ?? null}
                pending={curSig[core] !== savedSig[core]}
                cameraMatrix={slot?.cameras ?? []}
                availableCameras={availableCameras}
                excludedCameras={excludedFor(core)}
                occupiedCores={slot?.cores ?? []}
                running={running}
                editable={editable}
                dragging={dragging}
                dragKind={dragKind}
                onDropConfig={dropConfig}
                onCamerasChange={setCameras}
                onRemove={removeFromCore}
                onDragStart={(configId, sourceCoreId) => startDrag(configId, sourceCoreId, 'core')}
                onExpandAll={expandToAll}
              />
            );
          })}
        </div>

        {/* ── Правая колонка: список конфигураций ──────────── */}
        <div className="configs-col">
          <div className="configs-head">
            <span className="section-label" style={{ margin: 0 }}>Конфигурации</span>
            <button
              className="btn-refresh"
              disabled={cfgCooldown || busy}
              title="Обновить список"
              onClick={refreshConfigs}
            >
              обновить
            </button>
          </div>
          <div className="cfg-list">
            {cfgLoading ? (
              <div className="cfg-loader">
                <span className="cfg-spinner" />
                <span>загрузка конфигураций…</span>
              </div>
            ) : available.length === 0 ? (
              <span className="hint">нет конфигураций</span>
            ) : (
              available.map((c) => {
                const assignedCores = coresByConfigId[c.id] ?? [];
                return (
                  <div
                    key={c.id}
                    className={`cfg-list-item${assignedCores.length > 0 ? ' cfg-list-item-used' : ''}${editable ? ' draggable' : ''}`}
                    draggable={editable}
                    onDragStart={(e) => {
                      if (!editable) return;
                      e.dataTransfer.setData('application/x-config', c.id);
                      e.dataTransfer.effectAllowed = 'move';
                      startDrag(c.id, null, 'list');
                    }}
                  >
                    <div className="cfg-list-item-name">{c.name || c.id}</div>
                    <div className="cfg-list-item-meta">
                      <span className="cfg-list-item-id">{c.id}</span>
                      {assignedCores.length > 0 && (
                        <span className="cfg-list-item-cores">
                          {assignedCores.map((n) => `C${n}`).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {err && <div className="error-box" style={{ margin: '12px 0' }}>{err}</div>}

      {/* ── Подвал ──────────────────────────────────────────── */}
      <div className="cores-footer">
        <div className="cores-footer-status">
          <div className="mode-toggle">
            <button
              className={`mode-toggle-btn${mode === 'view' ? ' active' : ''}`}
              onClick={tryGoView}
            >
              Просмотр
            </button>
            <button
              className={`mode-toggle-btn${mode === 'edit' ? ' active' : ''}`}
              onClick={() => setMode('edit')}
            >
              Редактирование
            </button>
          </div>

          <span className={`supervisor-badge ${isSupervisorRunning ? 'supervisor-running' : 'supervisor-stopped'}`}>
            <span className="supervisor-dot" />
            {isSupervisorRunning ? 'SUPERVISOR RUNNING' : 'SUPERVISOR STOPPED'}
          </span>
          {editable && hasPendingChanges && <span className="pending-badge">изменения не применены</span>}
        </div>

        <div className="cores-footer-actions">
          {editable && (
            <>
              <button className="btn btn-ghost" disabled={busy || !hasPendingChanges} onClick={discardEdits}>
                Сбросить
              </button>
              <button className="btn btn-primary" disabled={busy || !hasPendingChanges} onClick={saveState}>
                Применить
              </button>
            </>
          )}

          {!isSupervisorRunning ? (
            <button className="btn btn-accent" disabled={busy} onClick={() => control('start')}>
              Start
            </button>
          ) : (
            <>
              <button className="btn btn-ghost" disabled={busy} onClick={() => control('restart')}>
                Restart
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => control('stop')}>
                Stop
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Модалка: несохранённые изменения при переходе в просмотр ── */}
      {switchModal && (
        <div className="modal-overlay" onClick={() => setSwitchModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Несохранённые изменения</div>
            <div className="modal-body">
              Есть изменения, которые не были применены. Сохраните их или сбросьте,
              прежде чем перейти в режим просмотра.
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" disabled={busy} onClick={() => setSwitchModal(false)}>
                Отмена
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={discardAndView}>
                Сбросить
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={applyAndView}>
                Применить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
