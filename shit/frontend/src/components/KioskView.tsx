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
    CheckCircle as CheckCircleIcon,
    Error as ErrorIcon,
    DragIndicator as DragIndicatorIcon,
    Close as CloseIcon,
    Settings as SettingsIcon,
} from '@mui/icons-material';
import { PlayerFactory, makeCameraTypeGetter } from './WebRTCPlayerFactory';
import { api } from '../services/api';
import type { CPPCamera } from '../types';
import { wsUrl } from '../utils/constants';
import CellMenu from './CellMenu';
import { useTouchDevice } from '../utils/useTouchDevice';
import { useLayouts, type SavedLayout } from '../hooks/Layouts';

interface CustomCell {
    id: string;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
}

const CONTROLS_HIDE_DELAY = 3000;

// Дефолтные лэйауты, которые всегда присутствуют (не хранятся на сервере)
const DEFAULT_LAYOUTS: SavedLayout[] = [
    {
        name: 'Панорама сверху',
        gridSize: 'single',
        activeCells: { single: 'linker_360' },
        timestamp: 0,
    },
];

const KioskView: React.FC = () => {
    const [layout, setLayout]           = useState<SavedLayout | null>(null);
    const [error, setError]             = useState<string>('');
    const [cameras, setCameras]         = useState<CPPCamera[]>([]);
    const isTouch                       = useTouchDevice();
    const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [drawerOpen, setDrawerOpen]   = useState(false);
    const hideTimerRef                  = useRef<number | null>(null);
    const [activeCellsOverride, setActiveCellsOverride] = useState<Record<number | string, string> | null>(null);
    const [draggedCamera, setDraggedCamera]   = useState<string | null>(null);
    const [dragOverCellId, setDragOverCellId] = useState<number | string | null>(null);

    // Сетки с сервера
    const { layouts: serverLayouts, loading: layoutsLoading } = useLayouts();

    // Объединяем дефолтные + серверные
    const availableLayouts: SavedLayout[] = [...serverLayouts, ...DEFAULT_LAYOUTS];

    const getCameraType       = makeCameraTypeGetter(cameras);
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
        api.getCameras()
            .then(data => { if (Array.isArray(data)) setCameras(data); })
            .catch(err => console.error('Kiosk: failed to load cameras', err));
    }, []);

    useEffect(() => {
        const handleFullscreenChange = () => {};
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    useEffect(() => {
        return () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    }, []);

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
    };

    const handleDragEnd = () => {
        // Вызывается всегда после drag — и при дропе в ячейку, и при дропе мимо.
        // handleDrop уже поставил камеру если дроп был в ячейку,
        // здесь просто чистим визуальное состояние в обоих случаях.
        setDraggedCamera(null);
        setDragOverCellId(null);
    };

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

    const getCameraStatus      = (cameraId: string) => cameras.find(c => c.id === cameraId)?.streams?.main?.status === 3;
    const getCameraDisplayName = (cameraId: string) => cameras.find(c => c.id === cameraId)?.display_name || cameraId;

    // ── Cell render ───────────────────────────────────────────────

    const renderCellContent = (cellId: number | string) => {
        const cameraName   = layout?.gridSize === 'single' ? effectiveActiveCells['single'] : effectiveActiveCells[cellId];
        const isDropTarget = dragOverCellId === cellId;
        const isDragging   = !!draggedCamera;
        const isSelecting  = !!selectedCamera;

        // Цвет обводки свободных ячеек когда активен какой-либо режим
        const borderStyle = isDropTarget
            ? '2px solid #4caf50'
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
                    // В режиме выбора камеры курсор pointer на всех ячейках
                    cursor: isSelecting ? 'pointer' : 'default',
                    transition: 'border-color 0.12s',
                    // Блокируем pointer-events видео во время drag/tap-режима
                    '& video, & > div > video': (isDragging || isSelecting) ? { pointerEvents: 'none' } : {},
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

                {activeCellsOverride && (
                    <Typography variant="caption" color="warning.main">● изменения не сохранены</Typography>
                )}

                <Box sx={{ flexGrow: 1 }} />

                <Tooltip title="Выйти из полноэкранного режима">
                    <IconButton size="small" sx={{ color: 'white' }} onClick={() => document.exitFullscreen().catch(() => {})}>
                        <FullscreenExitIcon />
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
                anchor="left" open={drawerOpen} onClose={() => setDrawerOpen(false)}
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
                    <Typography variant="subtitle1" fontWeight="bold">Камеры</Typography>
                    <IconButton size="small" sx={{ color: 'white' }} onClick={() => setDrawerOpen(false)}>
                        <CloseIcon />
                    </IconButton>
                </Box>
                <Divider sx={{ borderColor: 'grey.800', flexShrink: 0 }} />
                <Typography variant="caption" sx={{ px: 2, pt: 1, pb: 0.5, color: 'grey.500', display: 'block', flexShrink: 0 }}>
                    {isTouch ? 'Тап по камере → тап по ячейке.' : 'Перетащите или клик → клик по ячейке.'}
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
                    {cameras.map(camera => {
                        const isActive       = getCameraStatus(camera.id);
                        const isUsed         = Object.values(effectiveActiveCells).includes(camera.id);
                        const isBeingDragged = draggedCamera === camera.id;
                        const isSelected     = selectedCamera === camera.id;
                        return (
                            <ListItem key={camera.id} draggable
                                      onDragStart={(e) => handleDragStart(e, camera.id)}
                                      onDragEnd={handleDragEnd}
                                      onClick={() => setSelectedCamera(prev => prev === camera.id ? null : camera.id)}
                                      sx={{
                                          cursor: 'grab', opacity: isBeingDragged ? 0.5 : 1,
                                          bgcolor: isSelected ? 'rgba(33,150,243,0.35)' : isUsed ? 'rgba(76,175,80,0.15)' : 'transparent',
                                          borderLeft: isSelected ? '3px solid #2196f3' : isUsed ? '3px solid #4caf50' : '3px solid transparent',
                                          '&:active': { cursor: 'grabbing' },
                                          '&:hover': { bgcolor: isSelected ? 'rgba(33,150,243,0.45)' : 'rgba(255,255,255,0.08)' },
                                      }}
                            >
                                <ListItemIcon sx={{ minWidth: 32 }}>
                                    <DragIndicatorIcon sx={{ color: 'grey.600', fontSize: 16, mr: -0.5 }} />
                                    {isActive
                                        ? <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} />
                                        : <ErrorIcon sx={{ color: 'grey.600', fontSize: 18 }} />}
                                </ListItemIcon>
                                <ListItemText
                                    primary={camera.display_name || camera.id}
                                    secondary={camera.display_name ? camera.id : undefined}
                                    primaryTypographyProps={{ fontSize: '0.85rem', fontWeight: isSelected ? 600 : 400 }}
                                    secondaryTypographyProps={{ fontSize: '0.7rem', color: 'grey.600', fontFamily: 'monospace' }}
                                />
                            </ListItem>
                        );
                    })}
                    {cameras.length === 0 && (
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