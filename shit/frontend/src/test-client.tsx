import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useWebRTCPlayer } from './components/webrtc/useWebRTCPlayer';
import { signalingWsUrl } from './services/devices';
import './styles/tokens.css';

type Stream = { camera: string; stream?: string; device: string };
type Session = Stream & { id: string };
type Snapshot = { id: string; camera: string; stream?: string; status: string; width: number; height: number; time: number; fps: number | null; error?: string };
const snapshots = new Map<string, Snapshot>();
let setSessions: (sessions: Session[]) => void;
let sequence = 0;

function Player({ session }: { session: Session }) {
  const player = useWebRTCPlayer({ cameraId: session.camera, stream: session.stream, clientId: session.id,
    signalingUrl: signalingWsUrl(session.device, `/client/${session.camera}`), collectStats: true });
  useEffect(() => {
    const update = () => snapshots.set(session.id, { id: session.id, camera: session.camera, stream: session.stream,
      status: player.status, width: player.videoRef.current?.videoWidth || 0, height: player.videoRef.current?.videoHeight || 0,
      time: player.videoRef.current?.currentTime || 0, fps: player.stats?.fps ?? null, error: player.errorMsg || undefined });
    update();
    const timer = window.setInterval(update, 500);
    return () => { window.clearInterval(timer); snapshots.delete(session.id); };
  }, [player.status, player.stats, player.errorMsg, player.videoRef, session]);
  return <section><video ref={player.videoRef} autoPlay muted playsInline style={{ width: '100%', maxHeight: 260, background: '#000' }} /><p>{session.camera} / {session.stream || 'default'} — {player.status}</p></section>;
}

function App() {
  const [sessions, update] = useState<Session[]>([]);
  setSessions = update;
  return <main style={{ padding: 20 }}><h1 style={{ fontSize: 18, marginBottom: 20 }}>Клиент испытаний потоков</h1><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 16 }}>{sessions.map(session => <Player key={session.id} session={session} />)}</div></main>;
}

const rig = {
  open(streams: Stream[]) {
    const sessions = streams.map(stream => ({ ...stream, id: `test_${Date.now()}_${++sequence}_${Math.random().toString(36).slice(2)}` }));
    flushSync(() => setSessions(sessions));
    return sessions.map(session => session.id);
  },
  close() { flushSync(() => setSessions([])); return true; },
  snapshot() { return Array.from(snapshots.values()); },
};
declare global { interface Window { testRig: typeof rig } }
flushSync(() => createRoot(document.querySelector('#test-client')!).render(<App />));
window.testRig = rig;
