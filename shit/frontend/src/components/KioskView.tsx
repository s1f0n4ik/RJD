import React, { useState, useEffect, useRef } from 'react';
import {
    Box, Typography, Button, Alert, IconButton, Drawer,
    List, ListItem, ListItemIcon, ListItemText, Select, MenuItem,
    FormControl, InputLabel, Divider, Tooltip, CircularProgress,
} from '@mui/material';
import {
    Fullscreen as FullscreenIcon,
    Menu as MenuIcon,
    Home as HomeIcon,
    FullscreenExit as FullscreenExitIcon,
    Close as CloseIcon,
    Settings as SettingsIcon,
} from '@mui/icons-material';
import { PlayerFactory, makeCameraTypeGetter } from './WebRTCPlayerFactory';
import { api } from '../services/api';
import type { CPPCamera, VirtualStream } from '../types';
import {
    cameraToSource,
    makeCameraNameResolver,
    SOURCE_PLAYER_TYPE,
    streamToSource,
} from './streams/stream-sources';
import { wsUrl } from '../utils/constants';
import CellMenu from './CellMenu';
import { useTouchDevice } from '../utils/useTouchDevice';
import { useLayouts, type SavedLayout } from '../hooks/Layouts';

const CONTROLS_HIDE_DELAY = 3000;

const KioskView: React.FC = () => {
    const [layout, setLayout]           = useState<SavedLayout | null>(null);
    const [error, setError]             = useState<string>('');
    const [cameras, setCameras]         = useState<CPPCamera[]>([]);
    const [virtual, setVirtual]         = useState<VirtualStream[]>([]);
    const isTouch                       = useTouchDevice();
    const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [drawerOpen, setDrawerOpen]   = useState(false);
    const hideTimerRef                  = useRef<number | null>(null);
    const [activeCellsOverride, setActiveCellsOverride] = useState<Record<number | string, string> | null>(null);
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
    // У потоков обычный плеер, рамки в них уже врисованы
    const getCameraType       = (id: string) =>
        virtual.some(s => s.id === id) ? SOURCE_PLAYER_TYPE : cameraTypeOf(id);
    const effectiveActiveCells = activeCellsOverride ?? layout?.activeCells ?? {};

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
            setError('Нет сохранённых отображений');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutsLoading, serverLayouts]);

    useEffect(() => {
        api.getSources()
            .then(({ cameras: data, virtual: streams }) => {
                if (Array.isArray(data)) setCameras(data);
                setVirtual(streams);
            })
            .catch(err => console.error('Kiosk: failed to load cameras', err));
    }, []);

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
        window.location.href = '/';
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
        const video = document.getElementById(`kiosk-cell-${cellId}`)?.querySelector('video') as HTMLVideoElement | null;
        if (!video) return;
        const stream = video.srcObject as MediaStream | null;
        const hasLive = !!stream && stream.getVideoTracks().some(t => t.readyState === 'live');
        if (!hasLive || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        video.requestFullscreen?.().catch(err => console.error('Fullscreen failed:', err));
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

        // Цвет обводки
        const borderStyle = hasActiveCamera
            ? '2px solid #f44336'                       // красный — здесь уже стоит эта камера
            : isDropTarget
                ? '2px solid #4caf50'                    // зелёный — цель дропа
                : isDragging
                    ? '1px solid rgba(76,175,80,0.45)'
                    : isSelecting
                        ? '1px solid rgba(33,150,243,0.45)'
                        : '1px solid #222';

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
                    bgcolor: '#000',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden',
                    border: borderStyle,
                    cursor: isSelecting ? 'pointer' : 'default',
                    transition: 'border-color 0.12s, box-shadow 0.12s',
                    '& video, & > div > video': isModeActive ? { pointerEvents: 'none' } : {},
                    // Усиленный hover в режиме выбора — заметная синяя подсветка
                    ...(isSelecting && !hasActiveCamera && {
                        '&:hover': {
                            border: '2px solid #2196f3',
                            boxShadow: 'inset 0 0 0 9999px rgba(33,150,243,0.22)',
                        },
                    }),
                }}
            >
                {cameraName ? (
                    <>
                        <PlayerFactory
                            cameraType={getCameraType(cameraName)}
                            cameraId={cameraName}
                            cameraName={getCameraDisplayName(cameraName)}
                            signalingUrl={wsUrl(`/signaling/client/${cameraName}`)}
                            onError={(e) => console.error(e)}
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
                                    bgcolor: isDropTarget ? 'rgba(76,175,80,0.22)' : 'transparent',
                                    transition: 'background-color 0.12s',
                                }}
                            />
                        )}

                        {/* Overlay в режиме выбора камеры */}
                        {isSelecting && !isDragging && (
                            <Box sx={{
                                position: 'absolute', inset: 0, zIndex: 4,
                                bgcolor: 'rgba(33,150,243,0.10)',
                                pointerEvents: 'none',
                            }} />
                        )}
                    </>
                ) : (
                    /* Пустая ячейка — никакого текста, только подсветка в активных режимах */
                    <Box sx={{
                        position: 'absolute', inset: 0,
                        bgcolor: isDropTarget
                            ? 'rgba(76,175,80,0.18)'
                            : isDragging
                                ? 'rgba(76,175,80,0.05)'
                                : isSelecting
                                    ? 'rgba(33,150,243,0.07)'
                                    : 'transparent',
                        transition: 'background-color 0.12s',
                    }} />
                )}
            </Box>
        );
    };

    // ── Grid renders ──────────────────────────────────────────────

    const renderSingleView = () => (
        <Box sx={{ width: '100vw', height: '100vh', bgcolor: '#000' }}>
            {renderCellContent('single')}
        </Box>
    );

    const renderStandardGrid = () => {
        const gs   = layout!.gridSize as number;
        const cols = Math.sqrt(gs);
        return (
            <Box sx={{ width: '100vw', height: '100vh', display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 0.5, bgcolor: '#000', p: 0.5, boxSizing: 'border-box' }}>
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
            <Box sx={{ width: '100vw', height: '100vh', display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 0.5, bgcolor: '#000', p: 0.5, boxSizing: 'border-box' }}>
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
            <Box sx={{ minHeight: '100vh', bgcolor: '#000', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                <CircularProgress color="inherit" size={28} />
                <Typography>Загрузка отображений...</Typography>
            </Box>
        );
    }

    if (error) {
        return (
            <Box sx={{ minHeight: '100vh', bgcolor: '#000', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
                <Box sx={{ maxWidth: 600, width: '100%' }}>
                    <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>
                    {availableLayouts.length > 0 && (
                        <Box>
                            <Typography variant="h6" sx={{ mb: 2 }}>Доступные отображения:</Typography>
                            {availableLayouts.map(l => (
                                <Button key={l.name} fullWidth variant="outlined"
                                        sx={{ mb: 1, color: 'white', borderColor: 'white' }}
                                        onClick={() => { window.location.href = `/kiosk/${encodeURIComponent(l.name)}`; }}>
                                    {l.name}
                                </Button>
                            ))}
                        </Box>
                    )}
                    <Button fullWidth variant="contained" sx={{ mt: 2 }} onClick={() => window.location.href = '/'}>
                        Вернуться на главную
                    </Button>
                </Box>
            </Box>
        );
    }

    if (!layout) {
        return (
            <Box sx={{ minHeight: '100vh', bgcolor: '#000', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Typography>Загрузка...</Typography>
            </Box>
        );
    }

    // ── Main render ───────────────────────────────────────────────

    return (
        <Box sx={{ position: 'relative', width: '100vw', height: '100vh', bgcolor: '#000' }}>
            {layout.gridSize === 'custom'
                ? renderCustomGrid()
                : layout.gridSize === 'single'
                    ? renderSingleView()
                    : renderStandardGrid()}

            {/* Подсказка по центру при активном режиме выбора/перетаскивания */}
            {(selectedCamera || draggedCamera) && (
                <Box sx={{
                    position: 'fixed',
                    top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 1100,
                    pointerEvents: 'none',
                    bgcolor: 'rgba(0,0,0,0.82)',
                    color: 'white',
                    px: 3, py: 1.5,
                    borderRadius: 2,
                    border: `1px solid ${draggedCamera ? 'rgba(76,175,80,0.6)' : 'rgba(33,150,243,0.6)'}`,
                    display: 'flex', alignItems: 'center', gap: 1.5,
                    maxWidth: '80vw',
                    textAlign: 'center',
                    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                }}>
                    <Typography variant="body1" fontWeight={500}>
                        {draggedCamera
                            ? `Перетащите «${getCameraDisplayName(draggedCamera)}» в нужную ячейку`
                            : `Нажмите на ячейку, чтобы поставить «${getCameraDisplayName(selectedCamera!)}»`}
                    </Typography>
                </Box>
            )}

            {/* Верхняя шторка */}
            <Box sx={{
                position: 'fixed', top: 0, left: 0, right: 0,
                bgcolor: 'rgba(0,0,0,0.85)', color: 'white',
                px: 2, py: 1,
                display: 'flex', alignItems: 'center', gap: 2,
                transform: controlsVisible ? 'translateY(0)' : 'translateY(-100%)',
                transition: 'transform 0.25s ease',
                zIndex: 1200,
                pointerEvents: controlsVisible ? 'auto' : 'none',
            }}>
                <IconButton size="small" sx={{ color: 'white' }} onClick={() => setDrawerOpen(true)}>
                    <MenuIcon />
                </IconButton>
                <Typography variant="subtitle2">Трансляция</Typography>

                <FormControl size="small" sx={{ minWidth: 180 }}>
                    <InputLabel sx={{ color: 'grey.400' }}>Отображение</InputLabel>
                    <Select
                        value={layout.name}
                        label="Отображение"
                        onChange={(e) => handleSwitchLayout(e.target.value)}
                        sx={{
                            color: 'white', borderRadius: 0, bgcolor: '#1a1a1a',
                            '& .MuiOutlinedInput-notchedOutline': { borderColor: 'grey.900', borderRadius: 0 },
                            '& .MuiSvgIcon-root': { color: 'white' },
                            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'grey.700' },
                        }}
                        MenuProps={{ PaperProps: { sx: { borderRadius: 0, bgcolor: '#1a1a1a', color: 'white', '& .MuiMenuItem-root:hover': { bgcolor: 'rgba(255,255,255,0.08)' } } } }}
                    >
                        {availableLayouts.map(l => (
                            <MenuItem key={l.name} value={l.name}>{l.name}</MenuItem>
                        ))}
                    </Select>
                </FormControl>

                <Box sx={{ flexGrow: 1 }} />

                <Tooltip title={fullscreenActive ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим'}>
                    <IconButton
                        size="small"
                        sx={{ color: 'white' }}
                        onClick={() => {
                            if (document.fullscreenElement) {
                                document.exitFullscreen().catch(() => {});
                            } else {
                                document.documentElement.requestFullscreen().catch(() => {});
                            }
                        }}
                    >
                        {fullscreenActive ? <FullscreenExitIcon /> : <FullscreenIcon />}
                    </IconButton>
                </Tooltip>
                <Tooltip title="Вернуться на главную">
                    <IconButton size="small" sx={{ color: 'white' }} onClick={exitKiosk}>
                        <HomeIcon />
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
                        width: 260, bgcolor: '#1a1a1a', color: 'white',
                        zIndex: 1300,
                        pt: controlsVisible ? '56px' : 0,
                        transition: 'padding-top 0.25s ease',
                        overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    }}}
            >
                {/* Заголовок */}
                <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                    <Typography variant="subtitle1" fontWeight="bold">
                        {streamSources.length > 0 ? 'Источники' : 'Камеры'}
                    </Typography>
                    <IconButton size="small" sx={{ color: 'white' }} onClick={() => setDrawerOpen(false)}>
                        <CloseIcon />
                    </IconButton>
                </Box>
                <Divider sx={{ borderColor: 'grey.800', flexShrink: 0 }} />
                <Typography variant="caption" sx={{ px: 2, pt: 1, pb: 0.5, color: 'grey.500', display: 'block', flexShrink: 0 }}>
                    Перетащите камеру в ячейку или нажмите на камеру, потом в нужную ячейку.
                </Typography>

                {/* Список камер — только он скроллируется */}
                <List dense sx={{
                    flexGrow: 1, overflowY: 'auto', overflowX: 'hidden',
                    '&::-webkit-scrollbar': { width: '4px' },
                    '&::-webkit-scrollbar-track': { background: 'transparent' },
                    '&::-webkit-scrollbar-thumb': {
                        background: 'rgba(255,255,255,0.15)', borderRadius: '2px',
                        '&:hover': { background: 'rgba(255,255,255,0.3)' },
                    },
                    scrollbarWidth: 'thin',
                    scrollbarColor: 'rgba(255,255,255,0.15) transparent',
                }}>
                    {/* Секции показываются только когда есть потоки */}
                    {[
                        { title: 'Камеры', items: cameraSources },
                        { title: 'Виртуальные', items: streamSources },
                    ].filter(g => g.items.length > 0).map(group => (
                        <React.Fragment key={group.title}>
                            {streamSources.length > 0 && (
                                <Typography sx={{
                                    px: 2, pt: 1.1, pb: 0.7,
                                    fontSize: '0.65rem', fontWeight: 700,
                                    letterSpacing: '0.12em', textTransform: 'uppercase',
                                    color: 'grey.600',
                                    borderTop: '1px solid rgba(255,255,255,0.07)',
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
                                                  bgcolor: isSelected ? 'rgba(33,150,243,0.35)' : isUsed ? 'rgba(76,175,80,0.15)' : 'transparent',
                                                  borderLeft: isSelected ? '3px solid #2196f3' : isUsed ? '3px solid #4caf50' : '3px solid transparent',
                                                  '&:active': { cursor: 'grabbing' },
                                                  '&:hover': { bgcolor: isSelected ? 'rgba(33,150,243,0.45)' : 'rgba(255,255,255,0.08)' },
                                              }}
                                    >
                                        <ListItemIcon sx={{ minWidth: 20, alignSelf: 'flex-start', mt: 0.9 }}>
                                            <Box sx={{
                                                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                                bgcolor: source.active ? 'success.main' : 'grey.700',
                                            }} />
                                        </ListItemIcon>
                                        <ListItemText
                                            primary={source.name}
                                            secondary={source.detail}
                                            primaryTypographyProps={{
                                                fontSize: '0.85rem',
                                                fontWeight: isSelected ? 600 : 400,
                                                sx: { overflowWrap: 'anywhere' },
                                            }}
                                            secondaryTypographyProps={{
                                                fontSize: '0.7rem',
                                                color: 'grey.600',
                                                sx: { overflowWrap: 'anywhere' },
                                            }}
                                        />
                                    </ListItem>
                                );
                            })}
                        </React.Fragment>
                    ))}
                    {sources.length === 0 && (
                        <Box sx={{ p: 2 }}>
                            <Typography variant="caption" color="grey.500">Нет доступных камер</Typography>
                        </Box>
                    )}
                </List>

                {/* Футер */}
                <Divider sx={{ borderColor: 'grey.800', flexShrink: 0 }} />
                <List dense sx={{ flexShrink: 0 }}>
                    <ListItem onClick={() => { window.location.href = '/app'; }} sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' } }}>
                        <ListItemIcon sx={{ minWidth: 32 }}>
                            <SettingsIcon sx={{ color: 'grey.400', fontSize: 18 }} />
                        </ListItemIcon>
                        <ListItemText primary="Настройки" primaryTypographyProps={{ fontSize: '0.85rem' }} />
                    </ListItem>
                </List>
            </Drawer>
        </Box>
    );
};

export default KioskView;