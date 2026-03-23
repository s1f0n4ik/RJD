import React, { useState, useEffect, useRef } from 'react';
import {
  Container,
  Paper,
  Box,
  Grid,
  Typography,
  CircularProgress,
  Alert,
} from '@mui/material';
import { VideoLibrary } from '@mui/icons-material';
import { FASTAPI_BASE } from '../utils/constants';
import { RZD_COLORS } from '../theme';
import RecordingsCalendar from '../components/RecordingsCalendar';
import RecordingsCameraList from '../components/RecordingsCameraList';
import RecordingsFileList from '../components/RecordingsFileList';
import RecordingsPlayer from '../components/RecordingsPlayer';
import RecordingsTimeline from '../components/RecordingsTimeline';

interface Recording {
  filename: string;
  size: number;
  created: string;
  modified: string;
}

const RecordingsView: React.FC = () => {
  const [recordings, setRecordings] = useState<Record<string, Recording[]>>({});
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedCameras, setSelectedCameras] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ camera: string; file: Recording } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadRecordings();
  }, []);

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

  const handleCameraToggle = (cameraName: string) => {
    setSelectedCameras(prev => {
      if (prev.includes(cameraName)) {
        return prev.filter(c => c !== cameraName);
      } else {
        // Max 4 cameras
        if (prev.length >= 4) return prev;
        return [...prev, cameraName];
      }
    });
  };

  const handleFileSelect = (camera: string, file: Recording) => {
    setSelectedFile({ camera, file });
  };

  const getRecordingsForDate = (date: Date): string[] => {
    const dateStr = date.toISOString().split('T')[0];
    const cameras: string[] = [];

    Object.entries(recordings).forEach(([camera, files]) => {
      const hasRecording = files.some(file =>
        file.created.startsWith(dateStr)
      );
      if (hasRecording) cameras.push(camera);
    });

    return cameras;
  };

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
        <Box display="flex" alignItems="center" gap={2}>
          <VideoLibrary sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
          <Box>
            <Typography variant="h5" fontWeight="bold">
              📼 Recordings Archive
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Search and playback recorded videos
            </Typography>
          </Box>
        </Box>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/* Main Layout */}
      <Grid container spacing={2}>
        {/* Left: Video Player + Timeline */}
        <Grid item xs={12} lg={9}>
          <Paper sx={{ mb: 2, height: '60vh', bgcolor: 'black', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {selectedFile ? (
              <RecordingsPlayer
                camera={selectedFile.camera}
                file={selectedFile.file}
              />
            ) : (
              <Typography color="grey.500">
                Select a file to play
              </Typography>
            )}
          </Paper>

          {/* Timeline */}
          <Paper sx={{ p: 2, height: '150px' }}>
            <RecordingsTimeline
              camera={selectedCameras[0] || ''}
              date={selectedDate}
              onSeek={(time) => console.log('Seek to:', time)}
            />
          </Paper>
        </Grid>

        {/* Right: Calendar + Camera List + File List */}
        <Grid item xs={12} lg={3}>
          <Paper sx={{ p: 2, mb: 2 }}>
            <RecordingsCalendar
              selectedDate={selectedDate}
              onDateChange={setSelectedDate}
              highlightDates={Object.keys(recordings).flatMap(camera =>
                recordings[camera].map(f => new Date(f.created))
              )}
            />
          </Paper>

          <Paper sx={{ p: 2, mb: 2 }}>
            <RecordingsCameraList
              cameras={Object.keys(recordings)}
              selectedCameras={selectedCameras}
              onToggle={handleCameraToggle}
              recordings={recordings}
            />
          </Paper>

          <Paper sx={{ p: 2, maxHeight: '400px', overflow: 'auto' }}>
            <RecordingsFileList
              recordings={recordings}
              selectedCameras={selectedCameras}
              selectedDate={selectedDate}
              onFileSelect={handleFileSelect}
            />
          </Paper>
        </Grid>
      </Grid>
    </Container>
  );
};

export default RecordingsView;