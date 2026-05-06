import React, { useState } from 'react';
import { Box, IconButton, Menu, MenuItem, Tooltip } from '@mui/material';
import {
  MoreVert as MoreVertIcon,
  Fullscreen as FullscreenIcon,
  Close as CloseIcon,
} from '@mui/icons-material';

interface CellMenuProps {
  cellId: number | string;
  onFullscreen: (cellId: number | string) => void;
  onRemove: (cellId: number | string) => void;
  /** Если true, иконка всегда видна (для сенсорки). Иначе показывается только при hover */
  alwaysVisible?: boolean;
  /** Светлая тема (тёмный фон ячейки) или тёмная (светлый фон) */
  variant?: 'light' | 'dark';
}

const CellMenu: React.FC<CellMenuProps> = ({
  cellId,
  onFullscreen,
  onRemove,
  alwaysVisible = false,
  variant = 'light',
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

  const handleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFullscreen(cellId);
    setAnchorEl(null);
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(cellId);
    setAnchorEl(null);
  };

  const iconColor = variant === 'light' ? 'white' : 'rgba(0,0,0,0.75)';
  const bgColor = variant === 'light' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)';
  const bgHover = variant === 'light' ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,1)';

  return (
    <Box
      className="cell-menu-anchor"
      sx={{
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 20,
        opacity: alwaysVisible || open ? 1 : 0,
        transition: 'opacity 0.15s',
        // На ПК — показываем при hover родителя (.video-cell)
        '.video-cell:hover &': {
          opacity: 1,
        },
      }}
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
        <MenuItem onClick={handleFullscreen}>
          <FullscreenIcon fontSize="small" sx={{ mr: 1 }} />
          Полноэкранный режим
        </MenuItem>
        <MenuItem onClick={handleRemove}>
          <CloseIcon fontSize="small" sx={{ mr: 1 }} />
          Убрать камеру
        </MenuItem>
      </Menu>
    </Box>
  );
};

export default CellMenu;