import React, { useState } from 'react';
import { Box, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import {
    MoreVert as MoreVertIcon,
    Fullscreen as FullscreenIcon,
    Close as CloseIcon,
} from '@mui/icons-material';

interface CellMenuProps {
    cellId: number | string;
    onFullscreen: (cellId: number | string) => void;
    onRemove?: (cellId: number | string) => void;     // ← теперь опциональный
    /** Если true, иконка всегда видна (для сенсорки). Иначе показывается только при hover */
    alwaysVisible?: boolean;
    /** Светлая тема (тёмный фон ячейки) или тёмная (светлый фон) */
    variant?: 'light' | 'dark';
    /** Режим UI: 'menu' = три точки + меню, 'fullscreenOnly' = одна кнопка fullscreen внизу */
    mode?: 'menu' | 'fullscreenOnly';
    /** Имя камеры в overlay-плашке (если задано) */
    cameraName?: string;
}

const CellMenu: React.FC<CellMenuProps> = ({
                                               cellId,
                                               onFullscreen,
                                               onRemove,
                                               alwaysVisible = false,
                                               variant = 'light',
                                               mode = 'menu',
                                               cameraName,
                                           }) => {
    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);

    const handleOpen = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        e.preventDefault();
        setAnchorEl(e.currentTarget);
    };

    const handleClose = (e?: React.MouseEvent | {}) => {
        if (e && 'stopPropagation' in e) (e as React.MouseEvent).stopPropagation();
        setAnchorEl(null);
    };

    const handleFullscreenFromMenu = (e: React.MouseEvent) => {
        e.stopPropagation();
        onFullscreen(cellId);
        setAnchorEl(null);
    };

    const handleRemove = (e: React.MouseEvent) => {
        e.stopPropagation();
        onRemove?.(cellId);
        setAnchorEl(null);
    };

    const handleFullscreenDirect = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        e.preventDefault();
        onFullscreen(cellId);
    };

    const iconColor = variant === 'light' ? 'white' : 'rgba(0,0,0,0.75)';
    const bgColor = variant === 'light' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)';
    const bgHover = variant === 'light' ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,1)';

    // Общий стиль для overlay-кнопок (видны при hover родителя)
    const anchorBaseSx = {
        position: 'absolute' as const,
        zIndex: 20,
        opacity: alwaysVisible || open ? 1 : 0,
        transition: 'opacity 0.15s',
        '.video-cell:hover &': {
            opacity: 1,
        },
    };

    return (
        <>
            {/* Плашка с именем камеры — верх слева. Не зависит от mode. */}
            {cameraName && (
                <Box
                    sx={{
                        position: 'absolute',
                        top: 6,
                        left: 6,
                        zIndex: 19,
                        bgcolor: 'rgba(0,0,0,0.65)',
                        color: 'white',
                        px: 1,
                        py: 0.25,
                        borderRadius: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5,
                        backdropFilter: 'blur(4px)',
                        pointerEvents: 'none',
                        maxWidth: 'calc(100% - 60px)',  // оставляем место под кнопку справа
                    }}
                >
                    <Typography
                        variant="caption"
                        sx={{
                            fontSize: 12,
                            lineHeight: 1,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {cameraName}
                    </Typography>
                </Box>
            )}

            {/* Кнопка действий — позиция зависит от mode */}
            {mode === 'menu' ? (
                <Box
                    className="cell-menu-anchor"
                    sx={{ ...anchorBaseSx, top: 6, right: 6 }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                >
                    <Tooltip title="Действия с ячейкой">
                        <IconButton
                            size="small"
                            onClick={handleOpen}
                            sx={{
                                bgcolor: bgColor,
                                color: iconColor,
                                width: 32,
                                height: 32,
                                '&:hover': { bgcolor: bgHover },
                            }}
                        >
                            <MoreVertIcon fontSize="small" />
                        </IconButton>
                    </Tooltip>

                    <Menu
                        anchorEl={anchorEl}
                        open={open}
                        onClose={handleClose}
                        onClick={(e) => e.stopPropagation()}
                        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                    >
                        <MenuItem onClick={handleFullscreenFromMenu}>
                            <FullscreenIcon fontSize="small" sx={{ mr: 1 }} />
                            Полноэкранный режим
                        </MenuItem>
                        {onRemove && (
                            <MenuItem onClick={handleRemove}>
                                <CloseIcon fontSize="small" sx={{ mr: 1 }} />
                                Убрать камеру
                            </MenuItem>
                        )}
                    </Menu>
                </Box>
            ) : (
                // mode === 'fullscreenOnly'
                <Box
                    className="cell-menu-anchor"
                    sx={{
                        position: 'absolute',
                        bottom: 6,
                        right: 6,
                        zIndex: 20,
                        // opacity всегда 1 — кнопка fullscreen видна постоянно
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                >
                    <Tooltip title="Полноэкранный режим">
                        <IconButton
                            size="small"
                            onClick={handleFullscreenDirect}
                            sx={{
                                bgcolor: bgColor,
                                color: iconColor,
                                width: 32,
                                height: 32,
                                '&:hover': { bgcolor: bgHover },
                            }}
                        >
                            <FullscreenIcon fontSize="small" />
                        </IconButton>
                    </Tooltip>
                </Box>
            )}
        </>
    );
};

export default CellMenu;