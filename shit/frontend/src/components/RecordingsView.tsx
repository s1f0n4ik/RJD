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
  Chip,
  Button,
} from '@mui/material';
import {
  VideoLibrary,
  FiberManualRecord,
  CloudDownload,
  ContentCut,
} from '@mui/icons-material';
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
  const [currentFile, setCurrentFile] = useState<Recording | null>(null);
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(-1);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadRecordings();
  }, []);

  useEffect(() => {
    // Auto-select first camera and start playback
    if (!selectedCamera && Object.keys(recordings).length > 0) {
      const firstCamera = Object.keys(recordings)[0];
      setSelectedCamera(firstCamera);
      autoPlayLatestVideo(firstCamera);
    }
  }, [recordings]);

  useEffect(() => {
    if (selectedCamera && selectedDate) {
      const files = getFilesForSelectedDate();
      if (files.length > 1) {
        playFile(files[files.length - 2], files.length - 2);
      } else if (files.length === 1) {
        playFile(files[0], 0);
      }
    }
  }, [selectedCamera, selectedDate]);

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

  const autoPlayLatestVideo = (camera: string) => {
    const files = recordings[camera];
    if (files && files.length > 1) {
      const secondLast = files[files.length - 2];
      setCurrentFile(secondLast);
      setCurrentFileIndex(files.length - 2);
      console.log('🎬 Auto-playing second-to-last video (last one might be recording)');
    } else if (files && files.length === 1) {
      setCurrentFile(files[0]);
      setCurrentFileIndex(0);
    }
  };

  const handleCameraChange = (cameraName: string) => {
    setSelectedCamera(cameraName);
    setCurrentFile(null);
  };

  const handleDateChange = (date: Date) => {
    setSelectedDate(date);
    setCurrentFile(null);
  };

  const playFile = (file: Recording, index: number) => {
    setCurrentFile(file);
    setCurrentFileIndex(index);
  };

  const handleVideoEnded = () => {
    // Auto-play next video
    const files = getFilesForSelectedDate();
    const nextIndex = currentFileIndex + 1;

    if (nextIndex < files.length) {
      playFile(files[nextIndex], nextIndex);
    } else {
      console.log('🎬 Все видео воспроизведены');
    }
  };

  const handleTimelineSeek = (file: Recording) => {
    const files = getFilesForSelectedDate();
    const index = files.findIndex(f => f.filename === file.filename);
    if (index !== -1) {
      playFile(file, index);
    }
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
    return recordings[selectedCamera]
      .filter(f => f.created.startsWith(dateStr))
      .sort((a, b) => a.created.localeCompare(b.created));
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
      <Paper sx={{ p: 2, mb: 2 }}>
        <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={2}>
          <Box display="flex" alignItems="center" gap={2}>
            <VideoLibrary sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
            <Box>
              <Typography variant="h5" fontWeight="bold">
                📼 Архив записей
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Непрерывное воспроизведение • Кликайте на Timeline для перехода
              </Typography>
            </Box>
          </Box>

          {/* Camera Selector */}
          <FormControl sx={{ minWidth: 280 }}>
            <InputLabel>📹 Выберите камеру</InputLabel>
            <Select
              value={selectedCamera}
              onChange={(e) => handleCameraChange(e.target.value)}
              label="📹 Выберите камеру"
            >
              {cameraList.map(camera => (
                <MenuItem key={camera} value={camera}>
                  <Box display="flex" alignItems="center" gap={1} width="100%">
                    <FiberManualRecord
                      sx={{
                        fontSize: 12,
                        color: recordings[camera]?.length > 0 ? 'success.main' : 'grey.400'
                      }}
                    />
                    <Typography flexGrow={1}>{camera}</Typography>
                    <Chip
                      label={`${recordings[camera]?.length || 0} файлов`}
                      size="small"
                      color="primary"
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
            📹 Нет записей
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
            <Paper sx={{ mb: 2, height: '65vh', bgcolor: 'black', overflow: 'hidden' }}>
              {currentFile && selectedCamera ? (
                <RecordingsPlayer
                  camera={selectedCamera}
                  file={currentFile}
                  onEnded={handleVideoEnded}
                  onTimeUpdate={setCurrentTime}
                />
              ) : (
                <Box
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  height="100%"
                  textAlign="center"
                  p={4}
                >
                  <Box>
                    <Typography variant="h4" color="grey.600" gutterBottom>
                      👋 Добро пожаловать в Архив
                    </Typography>
                    <Typography variant="h6" color="grey.700" gutterBottom>
                      Выберите камеру вверху, затем кликните на Timeline
                    </Typography>
                    {!selectedCamera && (
                      <Chip label="1️⃣ Выберите камеру" color="warning" sx={{ mt: 2, fontSize: '1.1rem' }} />
                    )}
                    {selectedCamera && filesForDate.length === 0 && (
                      <Chip label="2️⃣ Выберите дату справа (синие дни = есть записи)" color="info" sx={{ mt: 2 }} />
                    )}
                  </Box>
                </Box>
              )}
            </Paper>

            {/* Timeline */}
            <Paper sx={{ p: 2 }}>
              <RecordingsTimeline
                camera={selectedCamera}
                date={selectedDate}
                files={filesForDate}
                currentTime={currentTime}
                onSeek={handleTimelineSeek}
              />
            </Paper>
          </Grid>

          {/* Right: Calendar */}
          <Grid item xs={12} lg={3}>
            {/* Calendar */}
            <Paper sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle1" fontWeight="bold" mb={2}>
                📅 Выберите дату
              </Typography>
              <RecordingsCalendar
                selectedDate={selectedDate}
                onDateChange={handleDateChange}
                highlightDates={getDatesWithRecordings()}
              />
              <Alert severity="info" sx={{ mt: 2 }} icon={false}>
                <strong>Синие дни</strong> = есть записи
              </Alert>
            </Paper>

            {/* Stats */}
            <Paper sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" fontWeight="bold" mb={1}>
                📊 Статистика
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Камера: <strong>{selectedCamera || 'Не выбрана'}</strong>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Дата: <strong>{selectedDate.toLocaleDateString('ru-RU')}</strong>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Файлов: <strong>{filesForDate.length}</strong>
              </Typography>
              {currentFile && (
                <Typography variant="body2" color="primary" sx={{ mt: 1 }}>
                  ▶️ Воспроизводится: {currentFileIndex + 1}/{filesForDate.length}
                </Typography>
              )}
            </Paper>

            {/* Download All */}
            {filesForDate.length > 0 && (
              <Paper sx={{ p: 2 }}>
                <Button
                  fullWidth
                  variant="outlined"
                  startIcon={<CloudDownload />}
                  onClick={() => alert('TODO: Скачать все видео за день')}
                >
                  Скачать все ({filesForDate.length})
                </Button>
                <Button
                  fullWidth
                  variant="contained"
                  startIcon={<ContentCut />}
                  sx={{ mt: 1 }}
                  onClick={() => alert('TODO: Выбрать диапазон и склеить')}
                >
                  Склеить диапазон
                </Button>
              </Paper>
            )}
          </Grid>
        </Grid>
      )}
    </Container>
  );
};

export default RecordingsView;