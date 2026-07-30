import React, { useState, useEffect, useRef } from 'react';
import {
    Box, Typography, Button, Alert, IconButton, Drawer,
    List, ListItem, ListItemIcon, ListItemText, Select, MenuItem,
    FormControl, Divider, Tooltip, CircularProgress,
} from '@mui/material';
import {
    Fullscreen as FullscreenIcon,
    Menu as MenuIcon,
    Home as HomeIcon,
    FullscreenExit as FullscreenExitIcon,
    Close as CloseIcon,
    Refresh as RefreshIcon,
    Settings as SettingsIcon,
} from '@mui/icons-material';
import { PlayerFactory, makeCameraTypeGetter, SURROUND_PLAYER_TYPE } from './WebRTCPlayerFactory';
import { api } from '../services/api';
import type { CPPCamera, VirtualStream } from '../types';
import {
    cameraToSource,
    makeCameraNameResolver,
    SOURCE_PLAYER_TYPE,
    streamToSource,
} from './streams/stream-sources';
import { wsUrl } from '../utils/constants';
import { modulePath, signalingWsUrl } from '../services/devices';
import CellMenu from './CellMenu';
import { useTouchDevice } from '../utils/useTouchDevice';
import { useLayouts, type SavedLayout } from '../hooks/Layouts';

const CONTROLS_HIDE_DELAY = 3000;

// Язык консоли техзрения (slate + iris); киоск всегда тёмный
const K = {
    base: '#0a0c11',
    surface: '#0f1218',
    panel: '#161a22',
    panel2: '#1c212c',
    border: '#252b39',
    cellBorder: '#1a2029',
    text: '#f1f3f9',
    text2: '#a6aec1',
    dim: '#667089',
    accent: '#4d8bff',
    accentGlow: 'rgba(77,139,255,0.18)',
    ok: '#4fbf87',
    warn: '#dcae4e',
    err: '#ec5f76',
    font: "'Inter', 'Noto Sans', system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, Consolas, monospace",
};

// Временная сетка, когда отображений нет: 4×4, изменения не сохраняются
const FALLBACK_GRID_SIZE = 16;

const KioskView: React.FC = () => {
    const [layout, setLayout]           = useState<SavedLayout | null>(null);
    const [error, setError]             = useState<string>('');
    const [cameras, setCameras]         = useState<CPPCamera[]>([]);
    const [virtual, setVirtual]         = useState<VirtualStream[]>([]);
    // Плееры монтируются только после первого списка источников: иначе URL
    // сигналинга меняется с fallback на device-путь и соединение поднимается дважды
    const [sourcesLoaded, setSourcesLoaded] = useState(false);
    const isTouch                       = useTouchDevice();
    const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [drawerOpen, setDrawerOpen]   = useState(false);
    const hideTimerRef                  = useRef<number | null>(null);
    const [activeCellsOverride, setActiveCellsOverride] = useState<Record<number | string, string> | null>(null);
    // Отображений нет: статичная сетка 4×4, панель раскрыта, ничего не сохраняется
    const [fallbackMode, setFallbackMode] = useState(false);
    // Жёлтый баннер временного режима можно закрыть до перезагрузки
    const [bannerClosed, setBannerClosed] = useState(false);
    // Перезагрузка отображения: пересоздаёт все плееры, расстановка не трогается
    const [reloadNonce, setReloadNonce] = useState(0);
    const [draggedCamera, setDraggedCamera]   = useState<string | null>(null);
    const [dragOverCellId, setDragOverCellId] = useState<number | string | null>(null);
    const [fullscreenActive, setFullscreenActive] = useState(!!document.fullscreenElement);

    // Сетки с сервера
    const { layouts: serverLayouts, loading: layoutsLoading } = useLayouts();

    const availableLayouts: SavedLayout[] = serverLayouts;

    // Камеры и потоки в одном списке, ячейка хранит только id
    const cameraSources = cameras.map(cameraToSource);
    const streamSources = virtual.map(s => streamToSource(s, makeCameraNameResolver(cameras)));
    const sources       = [...cameraSources, ...streamSources];

    const cameraTypeOf        = makeCameraTypeGetter(cameras);
    // У neural-потоков обычный плеер (рамки врисованы), у 360 — жестовый
    const getCameraType       = (id: string) => {
        const stream = virtual.find(s => s.id === id);
        if (!stream) return cameraTypeOf(id);
        return stream.producer === 'birdview' ? SURROUND_PLAYER_TYPE : SOURCE_PLAYER_TYPE;
    };
    const effectiveActiveCells = activeCellsOverride ?? layout?.activeCells ?? {};

    // Сигналинг устройства-владельца; без device_id — старый путь мастера
    const getSignalingUrl = (id: string) => {
        const owner = cameras.find(c => c.id === id)?.device_id
            ?? virtual.find(s => s.id === id)?.device_id;
        return owner ? signalingWsUrl(owner, `/client/${id}`) : wsUrl(`/signaling/client/${id}`);
    };

    const getLayoutNameFromUrl = (): string | null => {
        const match = window.location.pathname.match(/^\/kiosk\/?(.*)$/);
        if (!match) return null;
        const name = decodeURIComponent(match[1] || '').trim();
        return name || null;
    };

    // Сброс выбранной камеры по клику вне Drawer и вне ячеек
    useEffect(() => {
        if (!selectedCamera) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (
                target.closest('.MuiDrawer-paper') ||
                target.closest('.video-cell')
            ) return;
            setSelectedCamera(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [selectedCamera]);

    // Ждём загрузки сеток с сервера, затем выбираем нужную
    useEffect(() => {
        if (layoutsLoading) return;           // ждём пока придут с API

        const requestedName = getLayoutNameFromUrl();

        const found = requestedName
            ? availableLayouts.find(l => l.name === requestedName)
            : availableLayouts[0];

        if (found) {
            setLayout(found);
        } else if (requestedName) {
            setError(`Отображение "${requestedName}" не найдено`);
        } else if (availableLayouts.length === 0) {
            // Не ошибка: временная сетка и сразу раскрытый список камер
            setFallbackMode(true);
            setDrawerOpen(true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutsLoading, serverLayouts]);

    // Периодический опрос: статусы камер и пропажа устройств видны без перезагрузки
    useEffect(() => {
        const load = () => api.getSources()
            .then(({ cameras: data, virtual: streams }) => {
                if (Array.isArray(data)) setCameras(data);
                setVirtual(streams);
                setSourcesLoaded(true);
            })
            .catch(err => console.error('Kiosk: failed to load cameras', err));
        load();
        const timer = window.setInterval(load, 10_000);
        return () => window.clearInterval(timer);
    }, []);

    // Сохранённое состояние 360 из отображения: приводим вывод устройства
    // к нужному режиму один раз при загрузке (режим орбиты применяет плеер по WS).
    // 360-ячейки монтируются только после применения — иначе плеер успевает
    // подключиться к старому пайплайну и виснет на пересборке.
    const [surroundReady, setSurroundReady] = useState(false);
    const surroundAppliedRef = useRef(false);
    useEffect(() => {
        if (surroundAppliedRef.current) return;
        // Решение о layout ещё не принято — ждём
        if (!layout && !fallbackMode) return;
        surroundAppliedRef.current = true;

        const desired = layout?.surround;
        if (!desired) {
            setSurroundReady(true);
            return;
        }

        (async () => {
            try {
                const res = await fetch(modulePath('birdview', '/linker/status'));
                const d = (await res.json())?.data ?? {};
                const current = d?.view_mode === 'surround' ? 'surround' : 'top';
                if (current !== desired.viewMode) {
                    await fetch(modulePath('birdview', '/linker/view-mode'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ view_mode: desired.viewMode }),
                    });
                    // Ждём подъёма пересобранного вывода, но не бесконечно
                    const deadline = Date.now() + 20_000;
                    while (Date.now() < deadline) {
                        const st = await fetch(modulePath('birdview', '/linker/status'))
                            .then(r => r.json()).catch(() => null);
                        if (st?.data?.running) break;
                        await new Promise(r => setTimeout(r, 1_000));
                    }
                }
            } catch {
                // Устройства с birdview нет — состояние неприменимо
            } finally {
                setSurroundReady(true);
            }
        })();
    }, [layout, fallbackMode]);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setFullscreenActive(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    useEffect(() => {
        return () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    }, []);

    useEffect(() => {
        if (!drawerOpen) {
            setSelectedCamera(null);
        }
    }, [drawerOpen]);

    const scheduleHide = () => {
        if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
            if (!drawerOpen && !draggedCamera) setControlsVisible(false);
        }, CONTROLS_HIDE_DELAY);
    };

    useEffect(() => {
        const onMove = () => { setControlsVisible(true); scheduleHide(); };
        window.addEventListener('mousemove', onMove);
        scheduleHide();
        return () => {
            window.removeEventListener('mousemove', onMove);
            if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drawerOpen, draggedCamera]);

    const exitKiosk = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        window.location.href = '/app';
    };

    const handleSwitchLayout = (layoutName: string) => {
        const found = availableLayouts.find(l => l.name === layoutName);
        if (!found) return;
        setLayout(found);
        setActiveCellsOverride(null);
        window.history.replaceState(null, '', `/kiosk/${encodeURIComponent(layoutName)}`);
    };

    // ── Drag & Drop ───────────────────────────────────────────────

    const handleDragStart = (e: React.DragEvent, cameraName: string) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', cameraName);
        setDraggedCamera(cameraName);
        setSelectedCamera(null);   // режимы tap и drag не должны смешиваться
    };

    const handleDragEnd = () => {
        // Срабатывает в конце любого drag (в т.ч. при дропе мимо ячеек).
        // Чистим всё состояние режимов, чтобы ничего не «зависало».
        setDraggedCamera(null);
        setDragOverCellId(null);
        setSelectedCamera(null);
    }

    const handleDragOver = (e: React.DragEvent, cellId: number | string) => {
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if (dragOverCellId !== cellId) setDragOverCellId(cellId);
    };

    const handleDragLeave = (e: React.DragEvent, cellId: number | string) => {
        const related = e.relatedTarget as Node | null;
        if (related && (e.currentTarget as Node).contains(related)) return;
        if (dragOverCellId === cellId) setDragOverCellId(null);
    };

    const placeCameraInCell = (cellId: number | string, cameraName: string) => {
        const currentCells = activeCellsOverride ?? layout?.activeCells ?? {};
        const next = { ...currentCells };
        Object.entries(next).forEach(([id, name]) => {
            if (name === cameraName && id !== String(cellId)) delete next[id];
        });
        next[cellId] = cameraName;
        setActiveCellsOverride(next);
    };

    const handleCellTap = (cellId: number | string) => {
        if (!selectedCamera) return;
        // Клик по ячейке с той же камерой — отменяем режим
        const current = effectiveActiveCells[cellId];
        if (current === selectedCamera) {
            setSelectedCamera(null);
            return;
        }
        placeCameraInCell(cellId, selectedCamera);
        setSelectedCamera(null);
    };

    const handleCellFullscreen = (cellId: number | string) => {
        // Шторка вне fullscreen-элемента не видна — кнопка ячейки работает переключателем
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
            return;
        }
        const cell = document.getElementById(`kiosk-cell-${cellId}`);
        const video = cell?.querySelector('video') as HTMLVideoElement | null;
        if (!cell || !video) return;
        const stream = video.srcObject as MediaStream | null;
        const hasLive = !!stream && stream.getVideoTracks().some(t => t.readyState === 'live');
        if (!hasLive || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        // В полный экран уходит контейнер ячейки: канвас детекций и кнопки 360
        // остаются на экране вместе с видео
        cell.requestFullscreen?.().catch(err => console.error('Fullscreen failed:', err));
    };

    const handleCellRemove = (cellId: number | string) => {
        const currentCells = activeCellsOverride ?? layout?.activeCells ?? {};
        if (!currentCells[cellId]) return;
        const next = { ...currentCells };
        delete next[cellId];
        setActiveCellsOverride(next);
    };

    const handleDrop = (e: React.DragEvent, cellId: number | string) => {
        e.preventDefault(); e.stopPropagation();
        const cameraName = e.dataTransfer.getData('text/plain') || draggedCamera;
        if (!cameraName) return;
        placeCameraInCell(cellId, cameraName);
        setDraggedCamera(null);
        setDragOverCellId(null);
    };

    const getCameraDisplayName = (cameraId: string) => sources.find(s => s.id === cameraId)?.name || cameraId;

    const activeModeCamera = draggedCamera ?? selectedCamera;

    // ── Cell render ───────────────────────────────────────────────

    const renderCellContent = (cellId: number | string) => {
        const cameraName   = layout?.gridSize === 'single' ? effectiveActiveCells['single'] : effectiveActiveCells[cellId];
        const isDropTarget = dragOverCellId === cellId;
        const isDragging   = !!draggedCamera;
        const isSelecting  = !!selectedCamera;
        const isModeActive = isDragging || isSelecting;

        // Эта ячейка уже содержит активную (выбранную/перетаскиваемую) камеру
        const hasActiveCamera = !!activeModeCamera && cameraName === activeModeCamera;

        // Цвет обводки: ирисовый — интерактив, красный — камера уже здесь
        const borderStyle = hasActiveCamera
            ? `1.5px solid ${K.err}`
            : isDropTarget
                ? `1.5px dashed ${K.accent}`
                : isModeActive
                    ? '1px solid rgba(77,139,255,0.35)'
                    : `1px solid ${K.cellBorder}`;

        return (
            <Box
                id={`kiosk-cell-${cellId}`}
                className="video-cell"
                onDragOver={(e) => handleDragOver(e, cellId)}
                onDragEnter={(e) => handleDragOver(e, cellId)}
                onDragLeave={(e) => handleDragLeave(e, cellId)}
                onDrop={(e) => handleDrop(e, cellId)}
                onClick={() => handleCellTap(cellId)}
                sx={{
                    position: 'relative', width: '100%', height: '100%',
                    bgcolor: cameraName ? '#000' : K.surface,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden',
                    border: borderStyle,
                    borderRadius: '4px',
                    cursor: isSelecting ? 'pointer' : 'default',
                    transition: 'border-color 0.12s, box-shadow 0.12s',
                    '& video, & > div > video': isModeActive ? { pointerEvents: 'none' } : {},
                    // Усиленный hover в режиме выбора — ирисовая подсветка цели
                    ...(isSelecting && !hasActiveCamera && {
                        '&:hover': {
                            border: `1.5px dashed ${K.accent}`,
                            boxShadow: 'inset 0 0 0 9999px rgba(77,139,255,0.14)',
                        },
                    }),
                }}
            >
                {cameraName && sourcesLoaded
                    && (getCameraType(cameraName) !== SURROUND_PLAYER_TYPE || surroundReady) ? (
                    <>
                        <PlayerFactory
                            key={`pf-${cameraName}-${reloadNonce}`}
                            cameraType={getCameraType(cameraName)}
                            cameraId={cameraName}
                            cameraName={getCameraDisplayName(cameraName)}
                            signalingUrl={getSignalingUrl(cameraName)}
                            onError={(e) => console.error(e)}
                            surroundInitialManual={layout?.surround?.manual}
                        />
                        <CellMenu
                            cellId={cellId}
                            onFullscreen={handleCellFullscreen}
                            onRemove={handleCellRemove}
                            alwaysVisible={isTouch}
                            variant="light"
                            mode="fullscreenOnly"
                            cameraName={getCameraDisplayName(cameraName)}
                        />

                        {/* Полупрозрачный overlay во время drag — чтобы принять дроп поверх видео */}
                        {isDragging && (
                            <Box
                                onDragOver={(e) => handleDragOver(e, cellId)}
                                onDragEnter={(e) => handleDragOver(e, cellId)}
                                onDragLeave={(e) => handleDragLeave(e, cellId)}
                                onDrop={(e) => handleDrop(e, cellId)}
                                sx={{
                                    position: 'absolute', inset: 0, zIndex: 5,
                                    bgcolor: isDropTarget ? K.accentGlow : 'transparent',
                                    transition: 'background-color 0.12s',
                                }}
                            />
                        )}

                        {/* Overlay в режиме выбора камеры */}
                        {isSelecting && !isDragging && (
                            <Box sx={{
                                position: 'absolute', inset: 0, zIndex: 4,
                                bgcolor: 'rgba(77,139,255,0.08)',
                                pointerEvents: 'none',
                            }} />
                        )}
                    </>
                ) : (
                    /* Пустая ячейка — никакого текста, только подсветка в активных режимах */
                    <Box sx={{
                        position: 'absolute', inset: 0,
                        bgcolor: isDropTarget
                            ? K.accentGlow
                            : isModeActive
                                ? 'rgba(77,139,255,0.05)'
                                : 'transparent',
                        transition: 'background-color 0.12s',
                    }} />
                )}
            </Box>
        );
    };

    // ── Grid renders ──────────────────────────────────────────────

    const renderSingleView = () => (
        <Box sx={{ width: '100vw', height: '100vh', bgcolor: K.base }}>
            {renderCellContent('single')}
        </Box>
    );

    const renderStandardGrid = (gs: number) => {
        const cols = Math.sqrt(gs);
        // Явные строки: без них высота ячеек плавает от контента
        return (
            <Box sx={{ width: '100vw', height: '100vh', display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${gs / cols}, minmax(0, 1fr))`, gap: '2px', bgcolor: K.base, p: '2px', boxSizing: 'border-box' }}>
                {Array.from({ length: gs }).map((_, index) => (
                    <Box key={index} sx={{ minHeight: 0, minWidth: 0 }}>{renderCellContent(index)}</Box>
                ))}
            </Box>
        );
    };

    const renderCustomGrid = () => {
        const rows = layout!.customGridRows || 3;
        const cols = layout!.customGridCols || 3;
        return (
            <Box sx={{ width: '100vw', height: '100vh', display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, gap: '2px', bgcolor: K.base, p: '2px', boxSizing: 'border-box' }}>
                {(layout!.customCells || []).map(cell => (
                    <Box key={cell.id} sx={{ gridColumn: `${cell.col} / span ${cell.colSpan}`, gridRow: `${cell.row} / span ${cell.rowSpan}`, minHeight: 0, minWidth: 0 }}>
                        {renderCellContent(cell.id)}
                    </Box>
                ))}
            </Box>
        );
    };

    // ── Error / Loading ───────────────────────────────────────────

    if (layoutsLoading) {
        return (
            <Box sx={{ minHeight: '100vh', bgcolor: K.base, color: K.text2, fontFamily: K.font, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                <CircularProgress size={26} sx={{ color: K.accent }} />
                <Typography sx={{ fontFamily: K.font }}>Загрузка отображений…</Typography>
            </Box>
        );
    }

    if (error) {
        return (
            <Box sx={{ minHeight: '100vh', bgcolor: K.base, color: K.text, fontFamily: K.font, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
                <Box sx={{ maxWidth: 560, width: '100%' }}>
                    <Alert severity="error" sx={{
                        mb: 3, bgcolor: 'rgba(236,95,118,0.10)', color: K.err,
                        border: '1px solid rgba(236,95,118,0.35)', borderRadius: '8px',
                        '& .MuiAlert-icon': { color: K.err },
                    }}>{error}</Alert>
                    {availableLayouts.length > 0 && (
                        <Box>
                            <Typography sx={{ mb: 1.5, color: K.text2, fontFamily: K.font, fontWeight: 600 }}>
                                Доступные отображения:
                            </Typography>
                            {availableLayouts.map(l => (
                                <Button key={l.name} fullWidth variant="outlined"
                                        sx={{
                                            mb: 1, color: K.text, borderColor: K.border, borderRadius: '8px',
                                            textTransform: 'none', fontFamily: K.font,
                                            '&:hover': { borderColor: K.accent, bgcolor: K.accentGlow },
                                        }}
                                        onClick={() => { window.location.href = `/kiosk/${encodeURIComponent(l.name)}`; }}>
                                    {l.name}
                                </Button>
                            ))}
                        </Box>
                    )}
                    <Button fullWidth variant="contained" sx={{
                        mt: 2, bgcolor: K.accent, borderRadius: '8px', textTransform: 'none',
                        fontFamily: K.font, fontWeight: 600, '&:hover': { bgcolor: '#2f6fe0' },
                    }} onClick={() => window.location.href = '/kiosk'}>
                        Открыть прямой эфир
                    </Button>
                </Box>
            </Box>
        );
    }

    if (!layout && !fallbackMode) {
        return (
            <Box sx={{ minHeight: '100vh', bgcolor: K.base, color: K.text2, fontFamily: K.font, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Typography sx={{ fontFamily: K.font }}>Загрузка…</Typography>
            </Box>
        );
    }

    // ── Main render ───────────────────────────────────────────────

    return (
        <Box sx={{ position: 'relative', width: '100vw', height: '100vh', bgcolor: K.base, fontFamily: K.font }}>
            {!layout
                ? renderStandardGrid(FALLBACK_GRID_SIZE)
                : layout.gridSize === 'custom'
                    ? renderCustomGrid()
                    : layout.gridSize === 'single'
                        ? renderSingleView()
                        : renderStandardGrid(layout.gridSize as number)}

            {/* Жёлтый баннер временного режима */}
            {fallbackMode && !bannerClosed && (
                <Box sx={{
                    position: 'fixed', top: controlsVisible && !activeModeCamera ? 44 : 0, left: 0, right: 0,
                    zIndex: 1150,
                    display: 'flex', alignItems: 'center', gap: 1.25,
                    bgcolor: 'rgba(220,174,78,0.10)',
                    borderBottom: '1px solid rgba(220,174,78,0.35)',
                    backdropFilter: 'blur(6px)',
                    px: 2, py: 0.75,
                    color: K.warn, fontSize: '0.78rem',
                    transition: 'top 0.25s ease',
                }}>
                    <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: K.warn, boxShadow: '0 0 8px rgba(220,174,78,0.6)', flexShrink: 0 }} />
                    <Typography sx={{ fontSize: 'inherit', fontFamily: K.font }}>
                        Отображения не настроены — показана временная сетка, изменения не сохраняются
                    </Typography>
                    <Box sx={{ flexGrow: 1 }} />
                    <Box
                        component="a"
                        href="/app"
                        sx={{
                            color: K.warn, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
                            border: '1px solid rgba(220,174,78,0.45)', borderRadius: '6px', px: 1.25, py: 0.25,
                            '&:hover': { bgcolor: 'rgba(220,174,78,0.14)' },
                        }}
                    >
                        Создать отображение
                    </Box>
                    <IconButton
                        size="small"
                        onClick={() => setBannerClosed(true)}
                        sx={{ color: K.warn, p: 0.25, '&:hover': { bgcolor: 'rgba(220,174,78,0.14)' } }}
                    >
                        <CloseIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                </Box>
            )}

            {/* Подсказка по центру при активном режиме выбора/перетаскивания */}
            {(selectedCamera || draggedCamera) && (
                <Box sx={{
                    position: 'fixed',
                    top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 1100,
                    pointerEvents: 'none',
                    bgcolor: 'rgba(15,18,24,0.92)',
                    color: K.text,
                    px: 3, py: 1.5,
                    borderRadius: '8px',
                    border: `1px solid ${K.accent}`,
                    display: 'flex', alignItems: 'center', gap: 1.5,
                    maxWidth: '80vw',
                    textAlign: 'center',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                    backdropFilter: 'blur(6px)',
                }}>
                    <Typography variant="body1" fontWeight={500} sx={{ fontFamily: K.font }}>
                        {draggedCamera
                            ? `Перетащите «${getCameraDisplayName(draggedCamera)}» в нужную ячейку`
                            : `Нажмите на ячейку, чтобы поставить «${getCameraDisplayName(selectedCamera!)}»`}
                    </Typography>
                </Box>
            )}

            {/* Верхняя шторка */}
            <Box sx={{
                position: 'fixed', top: 0, left: 0, right: 0,
                height: 44,
                bgcolor: 'rgba(15,18,24,0.92)', color: K.text,
                borderBottom: `1px solid ${K.border}`,
                backdropFilter: 'blur(6px)',
                px: 1.5,
                display: 'flex', alignItems: 'center', gap: 1.5,
                // В режиме выбора/перетаскивания шторка не должна мешать видеть сетку
                transform: controlsVisible && !activeModeCamera ? 'translateY(0)' : 'translateY(-100%)',
                transition: 'transform 0.25s ease',
                zIndex: 1200,
                pointerEvents: controlsVisible && !activeModeCamera ? 'auto' : 'none',
            }}>
                <IconButton size="small" sx={{ color: K.text2, '&:hover': { color: K.text, bgcolor: K.panel2 } }} onClick={() => setDrawerOpen(true)}>
                    <MenuIcon fontSize="small" />
                </IconButton>
                <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, fontFamily: K.font }}>Прямой эфир</Typography>

                {layout ? (
                    <FormControl size="small" sx={{ minWidth: 170 }}>
                        <Select
                            value={layout.name}
                            onChange={(e) => handleSwitchLayout(e.target.value)}
                            sx={{
                                color: K.text, borderRadius: '8px', bgcolor: K.panel,
                                fontSize: '0.8rem', fontFamily: K.font,
                                '& .MuiOutlinedInput-notchedOutline': { borderColor: K.border, borderRadius: '8px' },
                                '& .MuiSvgIcon-root': { color: K.dim },
                                '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: K.accent },
                                '& .MuiSelect-select': { py: 0.6 },
                            }}
                            MenuProps={{ PaperProps: { sx: {
                                borderRadius: '8px', bgcolor: K.panel, color: K.text,
                                border: `1px solid ${K.border}`,
                                '& .MuiMenuItem-root': { fontSize: '0.8rem', fontFamily: K.font },
                                '& .MuiMenuItem-root:hover': { bgcolor: K.panel2 },
                            } } }}
                        >
                            {availableLayouts.map(l => (
                                <MenuItem key={l.name} value={l.name}>{l.name}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                ) : (
                    <Box sx={{
                        border: `1px dashed ${K.border}`, borderRadius: '8px',
                        px: 1.25, py: 0.5, fontSize: '0.75rem', color: K.dim, fontFamily: K.font,
                    }}>
                        Отображения не настроены
                    </Box>
                )}

                <Box sx={{ flexGrow: 1 }} />

                <Tooltip title="Перезагрузить отображение">
                    <IconButton
                        size="small"
                        sx={{ color: K.text2, '&:hover': { color: K.text, bgcolor: K.panel2 } }}
                        onClick={() => setReloadNonce(n => n + 1)}
                    >
                        <RefreshIcon fontSize="small" />
                    </IconButton>
                </Tooltip>
                <Tooltip title={fullscreenActive ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим'}>
                    <IconButton
                        size="small"
                        sx={{ color: K.text2, '&:hover': { color: K.text, bgcolor: K.panel2 } }}
                        onClick={() => {
                            if (document.fullscreenElement) {
                                document.exitFullscreen().catch(() => {});
                            } else {
                                document.documentElement.requestFullscreen().catch(() => {});
                            }
                        }}
                    >
                        {fullscreenActive ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
                    </IconButton>
                </Tooltip>
                <Tooltip title="На главную">
                    <IconButton size="small" sx={{ color: K.text2, '&:hover': { color: K.text, bgcolor: K.panel2 } }} onClick={exitKiosk}>
                        <HomeIcon fontSize="small" />
                    </IconButton>
                </Tooltip>
            </Box>

            {/* Боковая панель */}
            <Drawer
                anchor="left" open={drawerOpen}
                onClose={() =>
                    setDrawerOpen(false)
                }
                variant="persistent"
                ModalProps={{ keepMounted: true, hideBackdrop: true, disableEnforceFocus: true, disableAutoFocus: true, disableRestoreFocus: true }}
                PaperProps={{ sx: {
                        width: 260, bgcolor: K.surface, color: K.text,
                        borderRight: `1px solid ${K.border}`,
                        fontFamily: K.font,
                        zIndex: 1300,
                        pt: fallbackMode && !bannerClosed
                            ? (controlsVisible && !activeModeCamera ? '80px' : '36px')
                            : (controlsVisible && !activeModeCamera ? '44px' : 0),
                        transition: 'padding-top 0.25s ease, opacity 0.2s ease',
                        // Режим назначения: панель почти исчезает, чтобы видеть ячейки под ней.
                        // pointer-events глушим только в tap-режиме: во время drag это
                        // отменяет начатый браузером drag (источник внутри панели)
                        opacity: activeModeCamera ? 0.12 : 1,
                        pointerEvents: selectedCamera && !draggedCamera ? 'none' : 'auto',
                        overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    }}}
            >
                {/* Заголовок */}
                <Box sx={{ px: 1.5, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                    <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, fontFamily: K.font }}>
                        {streamSources.length > 0 ? 'Источники' : 'Камеры'}
                    </Typography>
                    <IconButton size="small" sx={{ color: K.dim, '&:hover': { color: K.text } }} onClick={() => setDrawerOpen(false)}>
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </Box>
                <Typography variant="caption" sx={{
                    px: 1.5, pb: 1, color: K.dim, display: 'block', flexShrink: 0,
                    fontSize: '0.68rem', lineHeight: 1.45, fontFamily: K.font,
                    borderBottom: `1px solid ${K.border}`,
                }}>
                    Перетащите камеру в ячейку или нажмите на камеру, потом в нужную ячейку.
                </Typography>

                {/* Список камер — только он скроллируется */}
                <List dense sx={{
                    flexGrow: 1, overflowY: 'auto', overflowX: 'hidden',
                    '&::-webkit-scrollbar': { width: '4px' },
                    '&::-webkit-scrollbar-track': { background: 'transparent' },
                    '&::-webkit-scrollbar-thumb': {
                        background: K.border, borderRadius: '2px',
                        '&:hover': { background: K.dim },
                    },
                    scrollbarWidth: 'thin',
                    scrollbarColor: `${K.border} transparent`,
                }}>
                    {/* Секции показываются только когда есть потоки */}
                    {[
                        { title: 'Камеры', items: cameraSources },
                        { title: 'Виртуальные', items: streamSources },
                    ].filter(g => g.items.length > 0).map(group => (
                        <React.Fragment key={group.title}>
                            {streamSources.length > 0 && (
                                <Typography sx={{
                                    px: 1.5, pt: 1.1, pb: 0.5,
                                    fontSize: '0.6rem', fontWeight: 700,
                                    letterSpacing: '0.14em', textTransform: 'uppercase',
                                    fontFamily: K.mono,
                                    color: K.dim,
                                }}>
                                    {group.title}
                                </Typography>
                            )}
                            {group.items.map(source => {
                                const isUsed         = Object.values(effectiveActiveCells).includes(source.id);
                                const isBeingDragged = draggedCamera === source.id;
                                const isSelected     = selectedCamera === source.id;
                                return (
                                    <ListItem key={source.id} draggable
                                              onDragStart={(e) => handleDragStart(e, source.id)}
                                              onDragEnd={handleDragEnd}
                                              onClick={() => setSelectedCamera(prev => prev === source.id ? null : source.id)}
                                              sx={{
                                                  cursor: 'grab', opacity: isBeingDragged ? 0.5 : 1,
                                                  bgcolor: isSelected ? K.accentGlow : isUsed ? 'rgba(79,191,135,0.07)' : 'transparent',
                                                  borderLeft: isSelected ? `3px solid ${K.accent}` : isUsed ? `3px solid ${K.ok}` : '3px solid transparent',
                                                  '&:active': { cursor: 'grabbing' },
                                                  '&:hover': { bgcolor: isSelected ? K.accentGlow : K.panel },
                                              }}
                                    >
                                        <ListItemIcon sx={{ minWidth: 20, alignSelf: 'flex-start', mt: 0.9 }}>
                                            <Box sx={{
                                                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                                                bgcolor: source.active ? K.ok : K.dim,
                                                boxShadow: source.active ? '0 0 6px rgba(79,191,135,0.6)' : 'none',
                                            }} />
                                        </ListItemIcon>
                                        <ListItemText
                                            primary={source.name}
                                            secondary={source.detail}
                                            primaryTypographyProps={{
                                                fontSize: '0.8rem',
                                                fontFamily: K.font,
                                                fontWeight: isSelected ? 600 : 400,
                                                sx: { overflowWrap: 'anywhere', color: isSelected ? K.accent : K.text },
                                            }}
                                            secondaryTypographyProps={{
                                                fontSize: '0.66rem',
                                                fontFamily: K.font,
                                                sx: { overflowWrap: 'anywhere', color: K.dim },
                                            }}
                                        />
                                    </ListItem>
                                );
                            })}
                        </React.Fragment>
                    ))}
                    {sources.length === 0 && (
                        <Box sx={{ p: 2 }}>
                            <Typography variant="caption" sx={{ color: K.dim, fontFamily: K.font }}>Нет доступных камер</Typography>
                        </Box>
                    )}
                </List>

                {/* Футер */}
                <Divider sx={{ borderColor: K.border, flexShrink: 0 }} />
                <List dense sx={{ flexShrink: 0 }}>
                    <ListItem onClick={() => { window.location.href = '/app'; }} sx={{ cursor: 'pointer', '&:hover': { bgcolor: K.panel } }}>
                        <ListItemIcon sx={{ minWidth: 32 }}>
                            <SettingsIcon sx={{ color: K.text2, fontSize: 16 }} />
                        </ListItemIcon>
                        <ListItemText primary="Настройки камер" primaryTypographyProps={{ fontSize: '0.8rem', fontFamily: K.font, sx: { color: K.text2 } }} />
                    </ListItem>
                </List>
            </Drawer>
        </Box>
    );
};

export default KioskView;