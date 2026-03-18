import React, { useState, useEffect } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  List,
  ListItem,
  ListItemText,
  IconButton,
  Chip,
  CircularProgress,
  Alert,
  Dialog,
  DialogContent,
} from '@mui/material';
import {
  ExpandMore,
  Download,
  PlayArrow,
  Folder,
  VideoLibrary,
} from '@mui/icons-material';
import { FASTAPI_BASE } from '../utils/constants';
import { RZD_COLORS } from '../theme';

interface Recording {
  filename: string;
  size: number;
  created: string;
  modified: string;
}

const Recordings: React.FC = () => {
  const [recordings, setRecordings] = useState<Record<string, Recording[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [playingVideo, setPlayingVideo] = useState<string | null>(null);

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

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (isoDate: string): string => {
    const date = new Date(isoDate);
    return date.toLocaleString('ru-RU');
  };

  const handleDownload = (cameraName: string, filename: string) => {
    window.open(`${FASTAPI_BASE}/api/recordings/download/${cameraName}/${filename}`, '_blank');
  };

  const handlePlay = (cameraName: string, filename: string) => {
    setPlayingVideo(`${FASTAPI_BASE}/api/recordings/stream/${cameraName}/${filename}`);
  };

  const totalCameras = Object.keys(recordings).length;
  const totalFiles = Object.values(recordings).reduce((sum, files) => sum + files.length, 0);

  if (loading) {
    return (
      <Container maxWidth="lg">
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
          <CircularProgress size={60} />
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box display="flex" alignItems="center" gap={2}>
          <VideoLibrary sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
          <Box>
            <Typography variant="h5" fontWeight="bold">
              📼 Архив видеозаписей
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Камер: {totalCameras} · Файлов: {totalFiles}
            </Typography>
          </Box>
        </Box>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {totalCameras === 0 ? (
        <Paper sx={{ p: 8, textAlign: 'center' }}>
          <Typography variant="h5" color="text.secondary" gutterBottom>
            Нет записей
          </Typography>
          <Typography color="text.secondary">
            Записи появятся после активации камер
          </Typography>
        </Paper>
      ) : (
        Object.entries(recordings).map(([cameraName, files]) => (
          <Accordion key={cameraName} defaultExpanded={files.length > 0}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box display="flex" alignItems="center" gap={2} width="100%">
                <Folder sx={{ color: RZD_COLORS.primary }} />
                <Typography variant="h6" fontWeight="bold">
                  {cameraName}
                </Typography>
                <Chip
                  label={`${files.length} файлов`}
                  size="small"
                  sx={{ ml: 'auto', mr: 2 }}
                />
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              {files.length === 0 ? (
                <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                  Нет записей
                </Typography>
              ) : (
                <List>
                  {files.map((file, index) => (
                    <ListItem
                      key={index}
                      sx={{
                        borderBottom: index < files.length - 1 ? `1px solid ${RZD_COLORS.grey[200]}` : 'none',
                        py: 2,
                      }}
                      secondaryAction={
                        <Box display="flex" gap={1}>
                          <IconButton
                            edge="end"
                            onClick={() => handlePlay(cameraName, file.filename)}
                            sx={{ color: RZD_COLORS.primary }}
                          >
                            <PlayArrow />
                          </IconButton>
                          <IconButton
                            edge="end"
                            onClick={() => handleDownload(cameraName, file.filename)}
                            sx={{ color: RZD_COLORS.secondary }}
                          >
                            <Download />
                          </IconButton>
                        </Box>
                      }
                    >
                      <ListItemText
                        primary={
                          <Typography variant="body1" fontWeight={600}>
                            {file.filename}
                          </Typography>
                        }
                        secondary={
                          <Box>
                            <Typography variant="caption" color="text.secondary">
                              🕒 {formatDate(file.created)} · 📦 {formatBytes(file.size)}
                            </Typography>
                          </Box>
                        }
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </AccordionDetails>
          </Accordion>
        ))
      )}

      {/* Видеоплеер */}
      <Dialog
        open={!!playingVideo}
        onClose={() => setPlayingVideo(null)}
        maxWidth="lg"
        fullWidth
      >
        <DialogContent sx={{ p: 0, bgcolor: 'black' }}>
          {playingVideo && (
            <video
              src={playingVideo}
              controls
              autoPlay
              style={{ width: '100%', height: 'auto', display: 'block' }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Container>
  );
};

export default Recordings;