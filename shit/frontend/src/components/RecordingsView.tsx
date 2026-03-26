import React, { useState, useEffect } from 'react';
import {
  Container,
  Paper,
  Box,
  Grid,
  Typography,
  CircularProgress,
  Alert,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Chip,
  IconButton,
} from '@mui/material';
import { VideoLibrary, PlayArrow, Download, FiberManualRecord } from '@mui/icons-material';
import { FASTAPI_BASE } from '../utils/constants';
import { RZD_COLORS } from '../theme';
import RecordingsCalendar from './RecordingsCalendar';
import RecordingsPlayer from './RecordingsPlayer';
import RecordingsTimeline from './RecordingsTimeline';

interface Recording {
  filename: string;
  size: number;
  created: string;
  modified: string;
}

const RecordingsView: React.FC = () => {
  const [recordings, setRecordings] = useState<Record<string, Recording[]>>({});
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedFile, setSelectedFile] = useState<Recording | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadRecordings();
  }, []);

  useEffect(() => {
    // Auto-select first camera
    if (!selectedCamera && Object.keys(recordings).length > 0) {
      setSelectedCamera(Object.keys(recordings)[0]);
    }
  }, [recordings]);

  const loadRecordings = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${FASTAPI_BASE}/api/recordings`);
      if (!response.ok) throw new Error('Failed to load recordings');

      const data = await response.json();
      setRecordings(data.recordings || {});
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCameraChange = (cameraName: string) => {
    setSelectedCamera(cameraName);
    setSelectedFile(null); // Reset video
  };

  const handleDateChange = (date: Date) => {
    setSelectedDate(date);
    setSelectedFile(null); // Reset video
  };

  const handleFileSelect = (file: Recording) => {
    setSelectedFile(file);
  };

  // Get dates with recordings for selected camera
  const getDatesWithRecordings = (): Date[] => {
    if (!selectedCamera || !recordings[selectedCamera]) return [];
    return recordings[selectedCamera].map(f => new Date(f.created));
  };

  // Get files for selected camera and date
  const getFilesForSelectedDate = (): Recording[] => {
    if (!selectedCamera || !recordings[selectedCamera]) return [];

    const dateStr = selectedDate.toISOString().split('T')[0];
    return recordings[selectedCamera].filter(f =>
      f.created.startsWith(dateStr)
    ).sort((a, b) => a.created.localeCompare(b.created));
  };

  const formatTime = (isoDate: string): string => {
    return new Date(isoDate).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatBytes = (bytes: number): string => {
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  };

  const filesForDate = getFilesForSelectedDate();
  const cameraList = Object.keys(recordings);

  if (loading) {
    return (
      <Container maxWidth="xl">
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
          <CircularProgress size={60} />
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="xl">
      {/* Header */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Box display="flex" alignItems="center" gap={2}>
            <VideoLibrary sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
            <Box>
              <Typography variant="h5" fontWeight="bold">
                📼 Архив записей
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Просмотр и поиск видеозаписей
              </Typography>
            </Box>
          </Box>

          {/* Camera Selector */}
          <FormControl sx={{ minWidth: 250 }}>
            <InputLabel>Выберите камеру</InputLabel>
            <Select
              value={selectedCamera}
              onChange={(e) => handleCameraChange(e.target.value)}
              label="Выберите камеру"
            >
              {cameraList.map(camera => (
                <MenuItem key={camera} value={camera}>
                  <Box display="flex" alignItems="center" gap={1}>
                    <FiberManualRecord
                      sx={{
                        fontSize: 12,
                        color: recordings[camera]?.length > 0 ? 'success.main' : 'grey.400'
                      }}
                    />
                    {camera}
                    <Chip
                      label={recordings[camera]?.length || 0}
                      size="small"
                      sx={{ ml: 1 }}
                    />
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {cameraList.length === 0 ? (
        <Paper sx={{ p: 8, textAlign: 'center' }}>
          <Typography variant="h5" color="text.secondary" gutterBottom>
            Нет записей
          </Typography>
          <Typography color="text.secondary">
            Записи появятся после активации камер
          </Typography>
        </Paper>
      ) : (
        <Grid container spacing={2}>
          {/* Left: Video Player + Timeline */}
          <Grid item xs={12} lg={9}>
            {/* Video Player */}
            <Paper sx={{ mb: 2, height: '60vh', bgcolor: 'black', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              {selectedFile && selectedCamera ? (
                <RecordingsPlayer
                  camera={selectedCamera}
                  file={selectedFile}
                />
              ) : (
                <Box textAlign="center">
                  <Typography variant="h6" color="grey.500" gutterBottom>
                    Выберите запись для воспроизведения
                  </Typography>
                  <Typography variant="body2" color="grey.600">
                    {!selectedCamera && 'Сначала выберите камеру'}
                    {selectedCamera && filesForDate.length === 0 && 'Нет записей для выбранной даты'}
                    {selectedCamera && filesForDate.length > 0 && 'Выберите время справа →'}
                  </Typography>
                </Box>
              )}
            </Paper>

            {/* Timeline */}
            <Paper sx={{ p: 2, height: '140px' }}>
              <RecordingsTimeline
                camera={selectedCamera}
                date={selectedDate}
                files={filesForDate}
                onSeek={(time) => console.log('Seek to:', time)}
              />
            </Paper>
          </Grid>

          {/* Right: Calendar + Time List */}
          <Grid item xs={12} lg={3}>
            {/* Calendar */}
            <Paper sx={{ p: 2, mb: 2 }}>
              <RecordingsCalendar
                selectedDate={selectedDate}
                onDateChange={handleDateChange}
                highlightDates={getDatesWithRecordings()}
              />
            </Paper>

            {/* Time List */}
            <Paper sx={{ p: 2, maxHeight: '400px', overflow: 'auto' }}>
              <Typography variant="subtitle2" fontWeight="bold" mb={1}>
                ⏰ Доступные записи
              </Typography>

              {!selectedCamera ? (
                <Typography variant="caption" color="text.secondary">
                  Выберите камеру
                </Typography>
              ) : filesForDate.length === 0 ? (
                <Typography variant="caption" color="text.secondary">
                  Нет записей для {selectedDate.toLocaleDateString('ru-RU')}
                </Typography>
              ) : (
                <List dense disablePadding>
                  {filesForDate.map((file, index) => (
                    <ListItem
                      key={file.filename}
                      disablePadding
                      secondaryAction={
                        <IconButton
                          size="small"
                          onClick={() =>
                            window.open(`${FASTAPI_BASE}/api/recordings/download/${selectedCamera}/${file.filename}`)
                          }
                        >
                          <Download fontSize="small" />
                        </IconButton>
                      }
                    >
                      <ListItemButton
                        selected={selectedFile?.filename === file.filename}
                        onClick={() => handleFileSelect(file)}
                        sx={{
                          borderRadius: 1,
                          mb: 0.5,
                          '&.Mui-selected': {
                            bgcolor: RZD_COLORS.primary + '20',
                            '&:hover': {
                              bgcolor: RZD_COLORS.primary + '30',
                            },
                          },
                        }}
                      >
                        <PlayArrow fontSize="small" sx={{ mr: 1, color: RZD_COLORS.primary }} />
                        <ListItemText
                          primary={
                            <Typography variant="body2" fontWeight={600}>
                              {formatTime(file.created)}
                            </Typography>
                          }
                          secondary={
                            <Typography variant="caption" color="text.secondary">
                              {formatBytes(file.size)}
                            </Typography>
                          }
                        />
                      </ListItemButton>
                    </ListItem>
                  ))}
                </List>
              )}
            </Paper>
          </Grid>
        </Grid>
      )}
    </Container>
  );
};

export default RecordingsView;