import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, CircularProgress, IconButton, Paper } from '@mui/material';
import { Fullscreen, Error as ErrorIcon } from '@mui/icons-material';

interface WebRTCPlayerProps {
  cameraId: string;
  signalingUrl: string;
  onError?: (error: string) => void;
}

const WebRTCPlayer: React.FC<WebRTCPlayerProps> = ({ cameraId, signalingUrl, onError }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const clientIdRef = useRef<string>('');

  useEffect(() => {
    clientIdRef.current = `client_${Math.random().toString(36).substr(2, 9)}`;
    connectWebRTC();

    return () => {
      cleanup();
    };
  }, [cameraId, signalingUrl]);

  const cleanup = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'close',
          client_id: clientIdRef.current,
          camera: cameraId,
          description: 'client disconnect'
        }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  const connectWebRTC = async () => {
    setStatus('connecting');

    try {
      const ws = new WebSocket(signalingUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log(`[${cameraId}] ✅ WebSocket connected`);

        const connectionRequest = {
          type: 'connection',
          client_id: clientIdRef.current,
          camera: cameraId,
          description: 'connect_request from client',
          ret: 'none'
        };

        ws.send(JSON.stringify(connectionRequest));
        console.log(`[${cameraId}] 📤 Sent connection request:`, connectionRequest);
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        console.log(`[${cameraId}] 📩 Received:`, msg.type);

        if (msg.type === 'connection') {
          if (msg.ret === 'success') {
            console.log(`[${cameraId}] ✅ Camera accepted connection, creating PeerConnection`);
            createPeerConnection();
          } else {
            console.error(`[${cameraId}] ❌ Camera rejected connection: ret=${msg.ret}`);
            setStatus('error');
            setErrorMsg('Камера отклонила соединение');
            onError?.('Camera rejected connection');
          }
          return;
        }

        if (msg.type === 'offer') {
          await handleOffer(msg.sdp);
        }

        if (msg.type === 'ice') {
          await handleIceCandidate(msg);
        }
      };

      ws.onerror = (error) => {
        console.error(`[${cameraId}] ❌ WebSocket error:`, error);
        setStatus('error');
        setErrorMsg('Ошибка подключения');
        onError?.('WebSocket error');
      };

      ws.onclose = () => {
        console.log(`[${cameraId}] 🔌 WebSocket closed`);
        setStatus('error');
        setErrorMsg('Соединение закрыто');
      };

    } catch (err) {
      console.error(`[${cameraId}] ❌ Connect error:`, err);
      setStatus('error');
      setErrorMsg('Не удалось подключиться');
      onError?.(String(err));
    }
  };

  const createPeerConnection = () => {
  console.log(`[${cameraId}] 🔧 Creating RTCPeerConnection...`);

  // ✅ ИСПРАВЛЕНО: Пустой объект как в connection.js
  const pc = new RTCPeerConnection({});
  pcRef.current = pc;

  // ✅ ВЕРНУЛИ: Точно как в connection.js!
  pc.addTransceiver('video', { direction: 'recvonly' });

  pc.onicecandidate = (event) => {
    if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
      const msg = {
        type: 'ice',
        client_id: clientIdRef.current,
        camera: cameraId,
        candidate: event.candidate.candidate,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        sdpMid: event.candidate.sdpMid,
        usernameFragment: event.candidate.usernameFragment,
      };
      wsRef.current.send(JSON.stringify(msg));
      console.log(`[${cameraId}] 📤 Sent ICE candidate`);
    }
  };

  pc.ontrack = (event) => {
    console.log(`[${cameraId}] 🎥 Got video track`);
    if (videoRef.current) {
      videoRef.current.srcObject = event.streams[0];
      setStatus('connected');
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${cameraId}] ICE connection state:`, pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${cameraId}] Connection state:`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('error');
      setErrorMsg('Соединение потеряно');
    }
  };
};

  const handleOffer = async (sdp: string) => {
    if (!pcRef.current) {
      console.error(`[${cameraId}] ❌ PeerConnection not created yet`);
      return;
    }

    console.log(`[${cameraId}] 📩 Received SDP offer`);
    console.log(`[${cameraId}] SDP preview:`, sdp.substring(0, 200) + '...');

    try {
      // ✅ ИСПРАВЛЕНО: Обработка ошибок + точная копия из connection.js
      const offer = {
        type: 'offer' as RTCSdpType,
        sdp: sdp
      };

      await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      console.log(`[${cameraId}] ✅ Remote description set`);

      console.log(`[${cameraId}] 🔧 Creating SDP answer...`);
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const response = {
          type: 'answer',
          client_id: clientIdRef.current,
          camera: cameraId,
          description: 'SDP answer from client',
          sdp: answer.sdp
        };
        wsRef.current.send(JSON.stringify(response));
        console.log(`[${cameraId}] 📤 Sent SDP answer`);
      }

    } catch (err) {
      console.error(`[${cameraId}] ❌ SDP Error:`, err);
      setStatus('error');
      setErrorMsg('Ошибка обработки SDP');
      onError?.(`SDP error: ${err}`);
    }
  };

  const handleIceCandidate = async (msg: any) => {
    if (!pcRef.current) return;

    try {
      // ✅ ИСПРАВЛЕНО: Точная копия из connection.js
      const iceCandidateInit: RTCIceCandidateInit = {
        candidate: msg.candidate,
        sdpMLineIndex: msg.sdpMLineIndex,
      };

      if (msg.sdpMid !== undefined) {
        iceCandidateInit.sdpMid = msg.sdpMid;
      }

      await pcRef.current.addIceCandidate(new RTCIceCandidate(iceCandidateInit));
    } catch (err) {
      console.error(`[${cameraId}] ❌ ICE error:`, err);
    }
  };

  const handleFullscreen = () => {
    if (videoRef.current) {
      videoRef.current.requestFullscreen();
    }
  };

  return (
    <Paper
      sx={{
        position: 'relative',
        bgcolor: 'black',
        overflow: 'hidden',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bgcolor: 'rgba(0,0,0,0.7)',
          color: 'white',
          px: 2,
          py: 1,
          zIndex: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography variant="body2" fontWeight="bold">
          {cameraId}
        </Typography>
        {status === 'connected' && (
          <IconButton size="small" onClick={handleFullscreen} sx={{ color: 'white' }}>
            <Fullscreen />
          </IconButton>
        )}
      </Box>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: status === 'connected' ? 'block' : 'none'
        }}
      />

      {status === 'connecting' && (
        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          sx={{ flexGrow: 1, color: 'white' }}
        >
          <CircularProgress size={40} sx={{ mb: 2 }} />
          <Typography>Подключение...</Typography>
        </Box>
      )}

      {status === 'error' && (
        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          sx={{ flexGrow: 1, color: 'white' }}
        >
          <ErrorIcon sx={{ fontSize: 48, mb: 2, color: 'error.main' }} />
          <Typography>{errorMsg}</Typography>
        </Box>
      )}
    </Paper>
  );
};

export default WebRTCPlayer;