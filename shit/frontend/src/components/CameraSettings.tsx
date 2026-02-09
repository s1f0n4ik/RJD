import React, { useState, useEffect } from 'react';
import {
  Container,
  Paper,
  Typography,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Chip,
  Box,
  Alert,
  Snackbar,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { api } from '../services/api';
import type {Camera, CameraFormData} from '../types';

const CameraSettings: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCamera, setEditingCamera] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const [formData, setFormData] = useState<CameraFormData>({
    camera_name: '',
    rtsp_url: '',
    width: null,
    height: null,
    reconnect_interval: 5,
  });

  useEffect(() => {
    loadCameras();
  }, []);

  const loadCameras = async () => {
    setLoading(true);
    try {
      const data = await api.getCameras();
      setCameras(data);
    } catch (error: any) {
      showSnackbar(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDialog = (camera?: Camera) => {
    if (camera) {
      setEditingCamera(camera.camera_name);
      setFormData({
        camera_name: camera.camera_name,
        rtsp_url: camera.rtsp_url,
        width: camera.width || null,
        height: camera.height || null,
        reconnect_interval: camera.reconnect_interval || 5,
      });
    } else {
      setEditingCamera(null);
      setFormData({
        camera_name: '',
        rtsp_url: '',
        width: null,
        height: null,
        reconnect_interval: 5,
      });
    }
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingCamera(null);
  };

  const handleSave = async () => {
    try {
      if (editingCamera) {
        // Обновление
        const { camera_name, ...updateData } = formData;
        await api.updateCamera(editingCamera, updateData);
        showSnackbar('Камера обновлена', 'success');
      } else {
        // Создание
        await api.createCamera(formData);
        showSnackbar('Камера добавлена', 'success');
      }
      handleCloseDialog();
      loadCameras();
    } catch (error: any) {
      showSnackbar(error.message, 'error');
    }
  };

  const handleDelete = async (cameraName: string) => {
    if (!window.confirm(`Удалить камеру ${cameraName}?`)) return;

    try {
      await api.deleteCamera(cameraName);
      showSnackbar('Камера удалена', 'success');
      loadCameras();
    } catch (error: any) {
      showSnackbar(error.message, 'error');
    }
  };

  const showSnackbar = (message: string, severity: 'success' | 'error') => {
    setSnackbar({ open: true, message, severity });
  };

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography variant="h5" fontWeight="bold">
            📹 Управление камерами
          </Typography>
          <Box>
            <IconButton onClick={loadCameras} disabled={loading} sx={{ mr: 1 }}>
              <RefreshIcon />
            </IconButton>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => handleOpenDialog()}
            >
              Добавить камеру
            </Button>
          </Box>
        </Box>

        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell><strong>Название</strong></TableCell>
                <TableCell><strong>RTSP URL</strong></TableCell>
                <TableCell align="center"><strong>Разрешение</strong></TableCell>
                <TableCell align="center"><strong>Статус</strong></TableCell>
                <TableCell align="center"><strong>Действия</strong></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {cameras.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center">
                    <Typography color="text.secondary">Нет камер</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                cameras.map((camera) => (
                  <TableRow key={camera.camera_name}>
                    <TableCell>{camera.camera_name}</TableCell>
                    <TableCell sx={{ fontSize: '0.85rem', color: 'text.secondary' }}>
                      {camera.rtsp_url}
                    </TableCell>
                    <TableCell align="center">
                      {camera.width && camera.height
                        ? `${camera.width}×${camera.height}`
                        : 'Авто'}
                    </TableCell>
                    <TableCell align="center">
                      <Chip
                        label={camera.status}
                        color={camera.status === 'running' ? 'success' : 'warning'}
                        size="small"
                      />
                    </TableCell>
                    <TableCell align="center">
                      <IconButton
                        size="small"
                        onClick={() => handleOpenDialog(camera)}
                        sx={{ mr: 1 }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => handleDelete(camera.camera_name)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Dialog for Add/Edit */}
      <Dialog open={dialogOpen} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>
          {editingCamera ? 'Редактировать камеру' : 'Добавить камеру'}
        </DialogTitle>
        <DialogContent>
          <TextField
            label="Название камеры"
            fullWidth
            margin="normal"
            value={formData.camera_name}
            onChange={(e) => setFormData({ ...formData, camera_name: e.target.value })}
            disabled={!!editingCamera}
            required
          />
          <TextField
            label="RTSP URL"
            fullWidth
            margin="normal"
            value={formData.rtsp_url}
            onChange={(e) => setFormData({ ...formData, rtsp_url: e.target.value })}
            placeholder="rtsp://admin:password@192.168.1.100:554/stream"
            required
          />
          <Box display="flex" gap={2}>
            <TextField
              label="Ширина"
              type="number"
              margin="normal"
              value={formData.width || ''}
              onChange={(e) => setFormData({ ...formData, width: e.target.value ? Number(e.target.value) : null })}
              placeholder="Авто"
            />
            <TextField
              label="Высота"
              type="number"
              margin="normal"
              value={formData.height || ''}
              onChange={(e) => setFormData({ ...formData, height: e.target.value ? Number(e.target.value) : null })}
              placeholder="Авто"
            />
          </Box>
          <TextField
            label="Интервал переподключения (сек)"
            type="number"
            fullWidth
            margin="normal"
            value={formData.reconnect_interval}
            onChange={(e) => setFormData({ ...formData, reconnect_interval: Number(e.target.value) })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Отмена</Button>
          <Button
            onClick={handleSave}
            variant="contained"
            disabled={!formData.camera_name || !formData.rtsp_url}
          >
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
      >
        <Alert severity={snackbar.severity} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Container>
  );
};

export default CameraSettings;