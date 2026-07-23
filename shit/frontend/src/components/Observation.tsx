import React, { useState, useEffect } from 'react';
import {
    Box,
    Typography,
    Paper,
    ToggleButtonGroup,
    ToggleButton,
    List,
    ListItem,
    ListItemText,
    ListItemIcon,
    Alert,
    Menu,
    MenuItem,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    TextField,
    IconButton,
    Select,
    FormControl,
    InputLabel,
    Tooltip,
    CircularProgress,
} from '@mui/material';

import {
    Videocam as VideocamIcon,
    Close as CloseIcon,
    Fullscreen as FullscreenIcon,
    GridOn as GridOnIcon,
    Save as SaveIcon,
    Delete as DeleteIcon,
    Visibility as VisibilityIcon,
    InfoOutlined as InfoOutlinedIcon,
} from '@mui/icons-material';
import { PlayerFactory, makeCameraTypeGetter } from './WebRTCPlayerFactory';
import { api } from '../services/api';
import { wsUrl } from '../utils/constants';
import type { CPPCamera, VirtualStream } from '../types';
import { isProbeCamera } from '../utils/probeFilter';
import {
    cameraToSource,
    makeCameraNameResolver,
    SOURCE_PLAYER_TYPE,
    streamToSource,
} from './streams/stream-sources';
import CellMenu from './CellMenu';
import { useTouchDevice } from '../utils/useTouchDevice';
import { useLayouts, type SavedLayout } from '../hooks/Layouts.ts';
import { RZD_COLORS } from '../theme';

type GridSize = 1 | 4 | 9 | 16 | 'custom';

interface CustomCell {
    id: string;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
}

const Observation: React.FC = () => {
    const getCameraDisplayName = (cameraId: string): string => {
        const s = sources.find(s => s.id === cameraId);
        return s?.name || cameraId;
    };

    const [cameras, setCameras]               = useState<CPPCamera[]>([]);
    const [virtual, setVirtual]               = useState<VirtualStream[]>([]);
    const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
    const [activeCells, setActiveCells]       = useState<Record<number | string, string>>({});
    const [gridSize, setGridSize]             = useState<GridSize>(4);
    const [loadError, setLoadError]           = useState<string>('');
    const [contextMenu, setContextMenu]       = useState<{
        mouseX: number;
        mouseY: number;
        cellId: number | string;
    } | null>(null);

    // Custom Grid
    const [customDialogOpen, setCustomDialogOpen] = useState(false);
    const [customCells, setCustomCells]           = useState<CustomCell[]>([]);
    const [customGridRows, setCustomGridRows]     = useState(3);
    const [customGridCols, setCustomGridCols]     = useState(3);
    const [isDrawing, setIsDrawing]               = useState(false);
    const [drawStart, setDrawStart]               = useState<{ row: number; col: number } | null>(null);
    const [drawEnd, setDrawEnd]                   = useState<{ row: number; col: number } | null>(null);
    const [selectedCellId, setSelectedCellId]     = useState<string | null>(null);

    // Layouts — теперь через API
    const {
        layouts: savedLayouts,
        loading: layoutsLoading,
        loadError: layoutsLoadError,
        opError: layoutsSaveError,
        clearOpError: clearLayoutsError,
        save: saveLayout,
        remove: removeLayout,
    } = useLayouts();
    const [saveLoading, setSaveLoading] = useState(false);
    const [currentLayoutName, setCurrentLayoutName] = useState('');
    const [saveDialogOpen, setSaveDialogOpen]       = useState(false);
    const [newLayoutName, setNewLayoutName]         = useState('');

    const [_, setDraggedCamera] = useState<string | null>(null);
    const isTouch = useTouchDevice();

    useEffect(() => {
        loadCameras();
    }, []);

    useEffect(() => {
        if (!selectedCamera) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.MuiListItem-root') || target.closest('.video-cell')) return;
            setSelectedCamera(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [selectedCamera]);

    const loadCameras = async () => {
        try {
            const { cameras: data, virtual: streams } = await api.getSources();
            if (!Array.isArray(data)) {
                setLoadError('Получены некорректные данные с сервера');
                setCameras([]);
                setVirtual([]);
                return;
            }
            const visible = data.filter((c) => !isProbeCamera(c.id));
            setCameras(visible);
            setVirtual(streams);
            setLoadError('');
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : 'Ошибка загрузки камер');
            setCameras([]);
            setVirtual([]);
        }
    };

    // ── Layout Management ────────────────────────────────────────

    const handleSaveCurrentLayout = async () => {
        if (!newLayoutName.trim()) return;
        setSaveLoading(true);
        const layout: SavedLayout = {
            name:           newLayoutName.trim(),
            gridSize,
            customCells:    gridSize === 'custom' ? customCells : undefined,
            customGridRows: gridSize === 'custom' ? customGridRows : undefined,
            customGridCols: gridSize === 'custom' ? customGridCols : undefined,
            activeCells:    activeCells as Record<string, string>,
            timestamp:      Date.now(),
        };
        const ok = await saveLayout(layout);
        setSaveLoading(false);
        if (ok) {
            setCurrentLayoutName(layout.name);
            setSaveDialogOpen(false);
            setNewLayoutName('');
        }
        // если !ok — opError уже установлен в хуке, покажется в Alert ниже
    };

    const loadLayout = (layoutName: string) => {
        const layout = savedLayouts.find(l => l.name === layoutName);
        if (!layout) return;
        setGridSize(layout.gridSize as GridSize);
        setActiveCells(layout.activeCells);
        if (layout.gridSize === 'custom' && layout.customCells) {
            setCustomCells(layout.customCells as CustomCell[]);
            setCustomGridRows(layout.customGridRows || 3);
            setCustomGridCols(layout.customGridCols || 3);
        }
        setCurrentLayoutName(layoutName);
    };

    const handleDeleteLayout = async (layoutName: string) => {
        if (!confirm(`Удалить отображение "${layoutName}"?`)) return;
        const ok = await removeLayout(layoutName);
        if (ok && currentLayoutName === layoutName) setCurrentLayoutName('');
    };

    // ── Grid ─────────────────────────────────────────────────────

    const handleGridSizeChange = (_: any, newSize: GridSize | null) => {
        if (!newSize) return;
        if (newSize === 'custom') {
            setCustomDialogOpen(true);
            return;
        }
        setGridSize(newSize);
        const newActiveCells: Record<number, string> = {};
        Object.entries(activeCells).forEach(([index, cameraName]) => {
            const numIndex = parseInt(index);
            if (!isNaN(numIndex) && numIndex < (newSize as number)) {
                newActiveCells[numIndex] = cameraName;
            }
        });
        setActiveCells(newActiveCells);
        setCurrentLayoutName('');
    };

    const handleGridCellMouseDown = (row: number, col: number) => {
        const clickedCell = customCells.find(cell =>
            row >= cell.row && row < cell.row + cell.rowSpan &&
            col >= cell.col && col < cell.col + cell.colSpan
        );
        if (clickedCell) { setSelectedCellId(clickedCell.id); return; }
        setIsDrawing(true);
        setDrawStart({ row, col });
        setDrawEnd({ row, col });
        setSelectedCellId(null);
    };

    const handleGridCellMouseEnter = (row: number, col: number) => {
        if (isDrawing && drawStart) setDrawEnd({ row, col });
    };

    const handleGridCellMouseUp = () => {
        if (isDrawing && drawStart && drawEnd) {
            const minRow = Math.min(drawStart.row, drawEnd.row);
            const maxRow = Math.max(drawStart.row, drawEnd.row);
            const minCol = Math.min(drawStart.col, drawEnd.col);
            const maxCol = Math.max(drawStart.col, drawEnd.col);
            const hasOverlap = customCells.some(cell => {
                const cellMaxRow = cell.row + cell.rowSpan - 1;
                const cellMaxCol = cell.col + cell.colSpan - 1;
                return !(maxRow < cell.row || minRow > cellMaxRow || maxCol < cell.col || minCol > cellMaxCol);
            });
            if (!hasOverlap) {
                const newCell: CustomCell = {
                    id: `custom-${Date.now()}`,
                    row: minRow, col: minCol,
                    rowSpan: maxRow - minRow + 1,
                    colSpan: maxCol - minCol + 1,
                };
                setCustomCells([...customCells, newCell]);
            }
        }
        setIsDrawing(false);
        setDrawStart(null);
        setDrawEnd(null);
    };

    const handleDeleteSelectedCell = () => {
        if (!selectedCellId) return;
        setCustomCells(customCells.filter(cell => cell.id !== selectedCellId));
        const next = { ...activeCells };
        delete next[selectedCellId];
        setActiveCells(next);
        setSelectedCellId(null);
    };

    const handleApplyCustomGrid = () => {
        if (customCells.length === 0) return;
        setGridSize('custom');
        setCustomDialogOpen(false);
        setCurrentLayoutName('');
    };

    const isCellInDrawRect = (row: number, col: number): boolean => {
        if (!drawStart || !drawEnd) return false;
        const minRow = Math.min(drawStart.row, drawEnd.row);
        const maxRow = Math.max(drawStart.row, drawEnd.row);
        const minCol = Math.min(drawStart.col, drawEnd.col);
        const maxCol = Math.max(drawStart.col, drawEnd.col);
        return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
    };

    const getCellAtPosition = (row: number, col: number): CustomCell | null =>
        customCells.find(cell =>
            row >= cell.row && row < cell.row + cell.rowSpan &&
            col >= cell.col && col < cell.col + cell.colSpan
        ) || null;

    const handleCellClick = (cellId: number | string) => {
        if (!selectedCamera) return;
        const usedInCell = Object.entries(activeCells).find(([id, name]) =>
            name === selectedCamera && id !== String(cellId)
        );
        setActiveCells(prev => {
            const next = { ...prev };
            if (usedInCell) delete next[usedInCell[0]];
            next[cellId] = selectedCamera;
            return next;
        });
        setCurrentLayoutName('');
        setSelectedCamera(null);
    };

    const handleCellRightClick = (event: React.MouseEvent, cellId: number | string) => {
        event.preventDefault();
        if (activeCells[cellId]) {
            setContextMenu({ mouseX: event.clientX, mouseY: event.clientY, cellId });
        }
    };

    const handleFullscreenCell = (cellId: number | string) => {
        const videoElement = document.getElementById(`video-cell-${cellId}`)?.querySelector('video');
        if (videoElement?.requestFullscreen) {
            videoElement.requestFullscreen().catch(err => console.error('Fullscreen failed:', err));
        }
    };

    const handleRemoveCameraFromCell = (cellId: number | string) => {
        setActiveCells(prev => { const next = { ...prev }; delete next[cellId]; return next; });
        setCurrentLayoutName('');
    };

    const handleDragStart = (event: React.DragEvent, cameraName: string) => {
        setDraggedCamera(cameraName);
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/plain', cameraName);
    };

    const handleDragEnd   = () => setDraggedCamera(null);
    const handleDragOver  = (event: React.DragEvent) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };

    const handleDrop = (event: React.DragEvent, cellId: number | string) => {
        event.preventDefault();
        const cameraName = event.dataTransfer.getData('text/plain');
        const usedInCell = Object.entries(activeCells).find(([id, name]) =>
            name === cameraName && id !== String(cellId)
        );
        if (usedInCell) {
            const next = { ...activeCells };
            delete next[usedInCell[0]];
            setActiveCells(next);
        }
        setActiveCells(prev => ({ ...prev, [cellId]: cameraName }));
        setDraggedCamera(null);
        setCurrentLayoutName('');
        setSelectedCamera(null);
    };

    const handleCellDoubleClick = (cellId: number | string) => {
        if (activeCells[cellId]) {
            setActiveCells(prev => { const next = { ...prev }; delete next[cellId]; return next; });
            setCurrentLayoutName('');
        }
    };

    const getGridCols = (): number => {
        if (gridSize === 'custom') return customGridCols;
        return Math.sqrt(gridSize as number);
    };

    // Камеры и потоки в одном списке, ячейка хранит только id
    const cameraSources = cameras.map(cameraToSource);
    const streamSources = virtual.map(s => streamToSource(s, makeCameraNameResolver(cameras)));
    const sources       = [...cameraSources, ...streamSources];

    const cameraTypeOf        = makeCameraTypeGetter(cameras);
    // У потоков обычный плеер, рамки в них уже врисованы
    const getCameraType       = (id: string) =>
        virtual.some(s => s.id === id) ? SOURCE_PLAYER_TYPE : cameraTypeOf(id);
    const isCameraUsedInGrid  = (cameraName: string) => Object.values(activeCells).includes(cameraName);
    const getCameraGridCell   = (cameraName: string) => Object.entries(activeCells).find(([_, n]) => n === cameraName)?.[0] ?? null;

    // ── Render helpers ───────────────────────────────────────────

    const renderCell = (cellId: number, cameraName: string | undefined) => (
        <Box
            id={`video-cell-${cellId}`}
            className="video-cell"
            key={cellId}
            onClick={() => handleCellClick(cellId)}
            onDoubleClick={() => handleCellDoubleClick(cellId)}
            onContextMenu={(e) => handleCellRightClick(e, cellId)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, cellId)}
            sx={{
                aspectRatio: '16/9',
                border: cameraName ? 'none' : '2px dashed #9e9e9e',
                borderRadius: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                bgcolor: cameraName ? 'black' : '#fafafa',
                cursor: cameraName ? 'context-menu' : 'pointer',
                position: 'relative', overflow: 'hidden',
                transition: 'all 0.2s',
                '&:hover': {
                    borderColor: cameraName ? RZD_COLORS.primaryDark : RZD_COLORS.primary,
                    boxShadow: `0 0 8px ${RZD_COLORS.primary}40`,
                },
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
                        onFullscreen={handleFullscreenCell}
                        onRemove={handleRemoveCameraFromCell}
                        alwaysVisible={isTouch}
                        variant="light"
                        mode="menu"
                        cameraName={getCameraDisplayName(cameraName)}
                    />
                </>
            ) : (
                <Box sx={{ textAlign: 'center', color: 'text.secondary' }}>
                    <VideocamIcon sx={{ fontSize: 60, mb: 1, opacity: 0.3 }} />
                    <Typography variant="body2" sx={{ opacity: 0.6 }}>
                        {selectedCamera ? 'Нажмите или перетащите' : 'Выберите камеру слева'}
                    </Typography>
                </Box>
            )}
        </Box>
    );

    const renderStandardGrid = () => {
        const cols = getGridCols();
        return (
            <Box sx={{
                flex: 1, p: 2,
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: 1, alignContent: 'start',
            }}>
                {Array.from({ length: gridSize as number }).map((_, index) => renderCell(index, activeCells[index]))}
            </Box>
        );
    };

    const renderCustomGrid = () => (
        <Box sx={{
            flex: 1, p: 2,
            display: 'grid',
            gridTemplateColumns: `repeat(${customGridCols}, 1fr)`,
            gridTemplateRows: `repeat(${customGridRows}, 1fr)`,
            gap: 1,
        }}>
            {customCells.map((cell) => {
                const cameraName = activeCells[cell.id];
                return (
                    <Box
                        key={cell.id}
                        id={`video-cell-${cell.id}`}
                        className="video-cell"
                        onClick={() => handleCellClick(cell.id)}
                        onDoubleClick={() => handleCellDoubleClick(cell.id)}
                        onContextMenu={(e) => handleCellRightClick(e, cell.id)}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, cell.id)}
                        sx={{
                            gridColumn: `${cell.col} / span ${cell.colSpan}`,
                            gridRow: `${cell.row} / span ${cell.rowSpan}`,
                            border: cameraName ? 'none' : '2px dashed #9e9e9e',
                            borderRadius: 1,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            bgcolor: cameraName ? 'black' : '#fafafa',
                            cursor: cameraName ? 'context-menu' : 'pointer',
                            position: 'relative', overflow: 'hidden',
                            transition: 'border-color 0.2s', minHeight: 200,
                            '&:hover': { borderColor: cameraName ? RZD_COLORS.primaryDark : RZD_COLORS.primary },
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
                                    cellId={cell.id}
                                    onFullscreen={handleFullscreenCell}
                                    onRemove={handleRemoveCameraFromCell}
                                    alwaysVisible={isTouch}
                                    variant="light"
                                    mode="menu"
                                    cameraName={getCameraDisplayName(cameraName)}
                                />
                            </>
                        ) : (
                            <Box sx={{ textAlign: 'center', color: 'text.secondary' }}>
                                <VideocamIcon sx={{ fontSize: 60, mb: 1, opacity: 0.3 }} />
                                <Typography variant="body2" sx={{ opacity: 0.6 }}>Перетащите камеру сюда</Typography>
                            </Box>
                        )}
                    </Box>
                );
            })}
        </Box>
    );

    // ── Render ───────────────────────────────────────────────────

    return (
        <Box sx={{ display: 'flex', height: 'calc(100vh - 120px)', gap: 0 }}>

            {/* LEFT PANEL */}
            <Paper elevation={3} sx={{ width: 200, flexShrink: 0, overflow: 'auto', borderRadius: 0 }}>
                <Box sx={{ p: 2, borderBottom: `1px solid ${RZD_COLORS.grey[200]}` }}>
                    {/* Пока потоков нет, в колонке только камеры */}
                    <Typography variant="subtitle2" fontWeight="bold">
                        {streamSources.length > 0 ? 'Источники' : 'Камеры'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">Перетащите в сетку</Typography>
                </Box>
                {loadError && <Alert severity="error" sx={{ m: 1 }}>{loadError}</Alert>}
                {/* Секции показываются только когда есть потоки */}
                {[
                    { title: 'Камеры', items: cameraSources },
                    { title: 'Виртуальные', items: streamSources },
                ].filter(g => g.items.length > 0).map(group => (
                    <React.Fragment key={group.title}>
                        {streamSources.length > 0 && (
                            <Box sx={{
                                px: 2, pt: 0.9, pb: 0.6,
                                bgcolor: RZD_COLORS.grey[100],
                                borderTop: `1px solid ${RZD_COLORS.grey[200]}`,
                                borderBottom: `1px solid ${RZD_COLORS.grey[200]}`,
                            }}>
                                <Typography sx={{
                                    fontSize: '0.65rem', fontWeight: 700,
                                    letterSpacing: '0.12em', textTransform: 'uppercase',
                                    color: 'text.secondary',
                                }}>
                                    {group.title}
                                </Typography>
                            </Box>
                        )}
                        <List dense>
                            {group.items.map((source) => {
                                const isSelected    = selectedCamera === source.id;
                                const isUsedInGrid  = isCameraUsedInGrid(source.id);
                                const gridCellId    = getCameraGridCell(source.id);
                                return (
                                    <ListItem
                                        key={source.id}
                                        button
                                        selected={isSelected}
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, source.id)}
                                        onDragEnd={handleDragEnd}
                                        onClick={() => setSelectedCamera(prev => prev === source.id ? null : source.id)}
                                        sx={{
                                            bgcolor: isSelected ? 'info.main' : isUsedInGrid ? 'rgba(76,175,80,0.08)' : 'transparent',
                                            color: isSelected ? 'white' : 'inherit',
                                            cursor: 'grab',
                                            borderLeft: isUsedInGrid && !isSelected ? '3px solid #4caf50' : 'none',
                                            paddingLeft: isUsedInGrid && !isSelected ? '13px' : '16px',
                                            '&:active': { cursor: 'grabbing' },
                                            '&:hover': { bgcolor: isSelected ? 'info.dark' : 'action.hover' },
                                            '&.Mui-selected': {
                                                bgcolor: 'info.main', borderLeft: 'none', paddingLeft: '16px',
                                                '&:hover': { bgcolor: 'info.dark' },
                                            },
                                        }}
                                    >
                                        <ListItemIcon sx={{ minWidth: 20, alignSelf: 'flex-start', mt: 0.9 }}>
                                            <Box sx={{
                                                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                                bgcolor: isSelected
                                                    ? 'white'
                                                    : source.active ? 'success.main' : RZD_COLORS.grey[300],
                                            }} />
                                        </ListItemIcon>
                                        <ListItemText
                                            primary={source.name}
                                            secondary={source.detail}
                                            primaryTypographyProps={{
                                                fontSize: '0.875rem',
                                                fontWeight: isSelected ? 600 : 400,
                                                sx: { overflowWrap: 'anywhere' },
                                            }}
                                            secondaryTypographyProps={{
                                                fontSize: '0.7rem',
                                                color: isSelected ? 'rgba(255,255,255,0.7)' : 'text.secondary',
                                                sx: { overflowWrap: 'anywhere' },
                                            }}
                                        />
                                        {isUsedInGrid && (
                                            <Tooltip title={`Ячейка ${gridCellId}`} placement="right">
                                                <VisibilityIcon sx={{ fontSize: 18, color: isSelected ? 'white' : 'success.main', ml: 0.5 }} />
                                            </Tooltip>
                                        )}
                                    </ListItem>
                                );
                            })}
                        </List>
                    </React.Fragment>
                ))}
                {sources.length === 0 && !loadError && (
                    <Box sx={{ p: 2, textAlign: 'center' }}>
                        <Typography variant="caption" color="text.secondary">Нет доступных камер</Typography>
                    </Box>
                )}
            </Paper>

            {/* CENTER PANEL */}
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto', bgcolor: RZD_COLORS.grey[100] }}>
                <Paper elevation={0} sx={{ p: 2, borderRadius: 0, borderBottom: `1px solid ${RZD_COLORS.grey[200]}` }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>

                        {/* Заголовок с подсказкой */}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Typography variant="h6" fontWeight="bold">Настройка видеосеток</Typography>
                            <Tooltip
                                title={
                                    <Box sx={{ p: 0.5 }}>
                                        <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
                                            Зачем нужны сетки?
                                        </Typography>
                                        <Typography variant="caption">
                                            Сохранённые сетки доступны в режиме трансляции.
                                            Сохраните текущую расстановку камер, затем откройте её
                                            в полноэкранном режиме — переключение между сетками
                                            доступно прямо в трансляции без выхода в настройки.
                                        </Typography>
                                    </Box>
                                }
                                placement="bottom-start"
                                arrow
                                componentsProps={{
                                    tooltip: {
                                        sx: {
                                            bgcolor: RZD_COLORS.grey[900],
                                            color: 'white',
                                            maxWidth: 280,
                                            fontSize: '0.8rem',
                                            borderRadius: 1,
                                            p: 1.5,
                                            '& .MuiTooltip-arrow': { color: RZD_COLORS.grey[900] },
                                        },
                                    },
                                }}
                            >
                                <InfoOutlinedIcon sx={{ fontSize: 18, color: 'text.disabled', cursor: 'help' }} />
                            </Tooltip>
                        </Box>

                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                            {layoutsLoading && <CircularProgress size={18} />}

                            {/* Выбор сохранённой сетки */}
                            <FormControl size="small" sx={{ minWidth: '200px' }}>
                                <InputLabel sx={{fontSize: '14px'}}>Сохраненные сетки</InputLabel>
                                <Select
                                    value={currentLayoutName}
                                    label="Сохраненные сетки"
                                    onChange={(e) => loadLayout(e.target.value)}
                                >
                                    <MenuItem value=""><em>Не выбрано</em></MenuItem>
                                    {savedLayouts.map((layout) => (
                                        <MenuItem key={layout.name} value={layout.name}>{layout.name}</MenuItem>
                                    ))}
                                </Select>
                            </FormControl>

                            <Tooltip title="Сохранить текущую сетку" arrow>
                                <IconButton size="small" color="primary" onClick={() => setSaveDialogOpen(true)}>
                                    <SaveIcon />
                                </IconButton>
                            </Tooltip>

                            {currentLayoutName && (
                                <Tooltip title="Удалить текущую сетку" arrow>
                                    <IconButton size="small" color="error" onClick={() => handleDeleteLayout(currentLayoutName)}>
                                        <DeleteIcon />
                                    </IconButton>
                                </Tooltip>
                            )}

                            <Tooltip
                                title={currentLayoutName
                                    ? `Открыть сетку "${currentLayoutName}" в режиме трансляции`
                                    : 'Сначала сохраните или загрузите сетку'}
                                arrow
                            >
                                {/* span нужен чтобы Tooltip работал на disabled кнопке */}
                                <span>
                  <Button
                      size="small"
                      variant="outlined"
                      color="primary"
                      startIcon={<FullscreenIcon />}
                      disabled={!currentLayoutName}
                      onClick={() => window.open(`/kiosk/${encodeURIComponent(currentLayoutName)}`, '_blank')}
                      sx={{ ml: 1, borderRadius: 1, padding: '5px 15px', fontSize: '14px' }}
                  >
                    Режим трансляции
                  </Button>
                </span>
                            </Tooltip>
                        </Box>
                    </Box>

                    {/* Ошибка загрузки — предупреждение, сетки просто недоступны */}
                    {layoutsLoadError && (
                        <Alert severity="warning" sx={{ mb: 2, borderRadius: 1 }} onClose={() => {}}>
                            Не удалось загрузить сетки с сервера: {layoutsLoadError}
                        </Alert>
                    )}

                    {/* Ошибка операции save/remove — кратко, закрываемая */}
                    {layoutsSaveError && (
                        <Alert severity="error" sx={{ mb: 2, borderRadius: 1 }} onClose={clearLayoutsError}>
                            {layoutsSaveError}
                        </Alert>
                    )}

                    <ToggleButtonGroup
                        value={gridSize}
                        exclusive
                        onChange={handleGridSizeChange}
                        size="small"
                        fullWidth
                    >
                        <ToggleButton value={1}>1×1</ToggleButton>
                        <ToggleButton value={4}>2×2</ToggleButton>
                        <ToggleButton value={9}>3×3</ToggleButton>
                        <ToggleButton value={16}>4×4</ToggleButton>
                        <ToggleButton value="custom">
                            <GridOnIcon sx={{ mr: 0.5 }} />
                            Произвольная
                        </ToggleButton>
                    </ToggleButtonGroup>
                </Paper>

                {gridSize === 'custom' ? renderCustomGrid() : renderStandardGrid()}
            </Box>

            {/* CONTEXT MENU */}
            <Menu open={contextMenu !== null} onClose={() => setContextMenu(null)}
                  anchorReference="anchorPosition"
                  anchorPosition={contextMenu !== null ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
            >
                <MenuItem onClick={() => { if (contextMenu) handleFullscreenCell(contextMenu.cellId); setContextMenu(null); }}>
                    <FullscreenIcon sx={{ mr: 1 }} /> Полноэкранный режим
                </MenuItem>
                <MenuItem onClick={() => { if (contextMenu) handleRemoveCameraFromCell(contextMenu.cellId); setContextMenu(null); }}>
                    <CloseIcon sx={{ mr: 1 }} /> Закрыть камеру
                </MenuItem>
            </Menu>

            {/* SAVE LAYOUT DIALOG */}
            <Dialog open={saveDialogOpen} onClose={() => setSaveDialogOpen(false)} maxWidth="xs" fullWidth
                    PaperProps={{ sx: { borderRadius: 1 } }}
            >
                <DialogTitle sx={{ bgcolor: RZD_COLORS.primary, color: 'white', py: 1.25, fontSize: '1rem' }}>
                    Сохранить сетку
                </DialogTitle>
                <DialogContent sx={{ pt: 2 }}>
                    {layoutsSaveError && (
                        <Alert severity="error" sx={{ mb: 1, borderRadius: 1 }}>{layoutsSaveError}</Alert>
                    )}
                    <TextField
                        autoFocus
                        margin="dense"
                        label="Название сетки"
                        fullWidth
                        value={newLayoutName}
                        onChange={(e) => setNewLayoutName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCurrentLayout(); }}
                        placeholder="Например: Охрана периметра"
                    />
                    {savedLayouts.find(l => l.name === newLayoutName) && (
                        <Alert severity="warning" sx={{ mt: 2, borderRadius: 1 }}>
                            Сетка с таким именем уже существует и будет перезаписана
                        </Alert>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setSaveDialogOpen(false)}>Отмена</Button>
                    <Button
                        onClick={handleSaveCurrentLayout}
                        variant="contained"
                        disabled={saveLoading || !newLayoutName.trim()}
                        startIcon={saveLoading ? <CircularProgress size={16} color="inherit" /> : undefined}
                        sx={{ bgcolor: RZD_COLORS.primary, borderRadius: 1 }}
                    >
                        Сохранить
                    </Button>
                </DialogActions>
            </Dialog>

            {/* VISUAL CUSTOM GRID EDITOR */}
            <Dialog open={customDialogOpen} onClose={() => setCustomDialogOpen(false)}
                    maxWidth="lg" fullWidth PaperProps={{ sx: { height: '90vh', borderRadius: 1 } }}
            >
                <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="h6">Редактор произвольной сетки</Typography>
                    <Box>
                        <TextField size="small" type="number" label="Строки" value={customGridRows}
                                   onChange={(e) => setCustomGridRows(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                                   sx={{ width: 80, mr: 1 }} InputProps={{ inputProps: { min: 1, max: 10 } }}
                        />
                        <TextField size="small" type="number" label="Колонки" value={customGridCols}
                                   onChange={(e) => setCustomGridCols(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                                   sx={{ width: 80 }} InputProps={{ inputProps: { min: 1, max: 10 } }}
                        />
                    </Box>
                </DialogTitle>
                <DialogContent>
                    <Alert severity="info" sx={{ mb: 2, borderRadius: 1 }}>
                        Зажмите ЛКМ и выделите область для создания ячейки.
                        Кликните на ячейку → Delete для удаления.
                    </Alert>
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: `repeat(${customGridCols}, 1fr)`,
                            gridTemplateRows: `repeat(${customGridRows}, 1fr)`,
                            gap: 0.5, height: 'calc(90vh - 250px)',
                            bgcolor: RZD_COLORS.grey[100], p: 2, borderRadius: 1, userSelect: 'none',
                        }}
                        onMouseUp={handleGridCellMouseUp}
                        onMouseLeave={handleGridCellMouseUp}
                        onKeyDown={(e) => { if (e.key === 'Delete' || e.key === 'Backspace') handleDeleteSelectedCell(); }}
                        tabIndex={0}
                    >
                        {Array.from({ length: customGridRows }).map((_, rowIndex) =>
                            Array.from({ length: customGridCols }).map((_, colIndex) => {
                                const row = rowIndex + 1;
                                const col = colIndex + 1;
                                const existingCell = getCellAtPosition(row, col);
                                const isInDrawRect = isCellInDrawRect(row, col);
                                const isSelected   = existingCell && existingCell.id === selectedCellId;
                                if (existingCell && !(existingCell.row === row && existingCell.col === col)) return null;
                                return (
                                    <Box key={`${row}-${col}`}
                                         onMouseDown={() => handleGridCellMouseDown(row, col)}
                                         onMouseEnter={() => handleGridCellMouseEnter(row, col)}
                                         sx={{
                                             gridColumn: existingCell ? `${existingCell.col} / span ${existingCell.colSpan}` : 'auto',
                                             gridRow: existingCell ? `${existingCell.row} / span ${existingCell.rowSpan}` : 'auto',
                                             border: existingCell
                                                 ? `3px solid ${isSelected ? '#f44336' : RZD_COLORS.primary}`
                                                 : isInDrawRect ? '2px solid #4caf50' : '1px dashed #ccc',
                                             borderRadius: 1,
                                             bgcolor: existingCell
                                                 ? isSelected ? 'rgba(244,67,54,0.1)' : `${RZD_COLORS.primary}18`
                                                 : isInDrawRect ? 'rgba(76,175,80,0.2)' : 'white',
                                             cursor: existingCell ? 'pointer' : 'crosshair',
                                             display: 'flex', alignItems: 'center', justifyContent: 'center',
                                             transition: 'all 0.1s',
                                         }}
                                    >
                                        {existingCell && existingCell.row === row && existingCell.col === col && (
                                            <Typography variant="caption" color="primary" fontWeight="bold">
                                                {existingCell.rowSpan}×{existingCell.colSpan}
                                            </Typography>
                                        )}
                                    </Box>
                                );
                            })
                        )}
                    </Box>
                    <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Typography variant="body2" color="text.secondary">
                            Создано ячеек: {customCells.length}
                            {selectedCellId && ' · выбрана (Delete для удаления)'}
                        </Typography>
                        <Button variant="outlined" color="error" size="small"
                                onClick={() => { if (confirm('Удалить все ячейки?')) { setCustomCells([]); setSelectedCellId(null); } }}
                                disabled={customCells.length === 0}
                        >
                            Очистить всё
                        </Button>
                    </Box>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCustomDialogOpen(false)}>Отмена</Button>
                    <Button onClick={handleApplyCustomGrid} variant="contained" disabled={customCells.length === 0}
                            sx={{ bgcolor: RZD_COLORS.primary, borderRadius: 1 }}
                    >
                        Применить ({customCells.length} ячеек)
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default Observation;