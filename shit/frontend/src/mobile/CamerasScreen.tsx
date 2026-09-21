import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../app/Icons';
import { useSystem } from '../app/SystemContext';
import { useDeviceClock } from '../app/useDeviceClock';
import { api } from '../services/api';
import { signalingWsUrl } from '../services/devices';
import { wsUrl } from '../utils/constants';
import { isProbeCamera } from '../utils/probeFilter';
import { CellPlayer } from '../screens/live/CellPlayer';
import { SurroundCell } from '../screens/live/SurroundCell';
import { cameraToWallSource, virtualToWallSource, type WallSource } from '../screens/live/sources';
import type { PlayerStats, PlayerStatus } from '../components/webrtc/useWebRTCPlayer';
import type { CPPCamera, StreamPurpose, VirtualStream } from '../types';
import '../screens/live/wall.css';

const SOURCES_POLL_MS = 10_000;

const PURPOSE_TAG: Partial<Record<StreamPurpose, { label: string; cls: string }>> = {
    neural: { label: 'Тех. зрение', cls: 'is-acc' },
    birdview: { label: '360', cls: 'is-viol' },
    record: { label: 'Запись', cls: '' },
};

const OVERLAYS = { name: false, time: false, stats: false };

const num = (value: number | null | undefined, digits: number) =>
    (value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ','));

// Самый лёгкий смотрибельный поток: телефону хватает подпотока
function lightestStream(camera: CPPCamera): string | undefined {
    return Object.entries(camera.streams ?? {})
        .filter(([, s]) => s.purposes?.includes('view'))
        .sort((a, b) => (a[1].width || 1e9) - (b[1].width || 1e9))[0]?.[0];
}

function mainStream(camera: CPPCamera) {
    return Object.values(camera.streams ?? {}).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
}

function purposesOf(camera: CPPCamera): StreamPurpose[] {
    const set = new Set<StreamPurpose>();
    Object.values(camera.streams ?? {}).forEach(s => s.purposes?.forEach(p => set.add(p)));
    return (['neural', 'birdview', 'record'] as StreamPurpose[]).filter(p => set.has(p));
}

const SkRow = ({ i }: { i: number }) => (
    <div className="m-li">
        <div className="t">
            <span className="skel h16" style={{ width: i % 2 ? 140 : 100 }} />
            <div className="m-tags"><span className="skel h16" style={{ width: 70, borderRadius: 5 }} /><span className="skel h16" style={{ width: 52, borderRadius: 5 }} /></div>
        </div>
        <div className="v"><span className="skel h16" style={{ width: 70, marginLeft: 'auto' }} /><span className="skel h10" style={{ width: 80, margin: '6px 0 0 auto' }} /></div>
        <span className="dot" />
    </div>
);

export default function CamerasScreen() {
    const { connected, cameras: allCameras } = useSystem();
    const { unixMs } = useDeviceClock();
    const boxRef = useRef<HTMLDivElement>(null);

    const cameras = useMemo(() => allCameras.filter(c => !isProbeCamera(c.display_name)), [allCameras]);
    // Выводы модулей приходят отдельным опросом, как в редакторе сеток
    const [virtual, setVirtual] = useState<VirtualStream[] | null>(null);
    useEffect(() => {
        let alive = true;
        const load = () => api.getSources()
            .then(res => { if (alive) setVirtual(res.virtual); })
            .catch(() => { if (alive) setVirtual(v => v ?? []); });
        load();
        const timer = window.setInterval(load, SOURCES_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, []);

    const sources: WallSource[] = useMemo(() => [
        ...cameras.map(cameraToWallSource),
        ...(virtual ?? []).map(stream => virtualToWallSource(stream, id => cameras.find(c => c.id === id)?.display_name || id)),
    ], [cameras, virtual]);
    const modules = sources.filter(s => s.kind === 'virtual');

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [status, setStatus] = useState<PlayerStatus>('connecting');
    const [stats, setStats] = useState<PlayerStats | null>(null);

    // Первая камера в эфире выбирается сама, пропавший источник отпускается
    useEffect(() => {
        if (selectedId && sources.some(s => s.id === selectedId)) return;
        const first = sources.find(s => s.active) ?? sources[0];
        setSelectedId(first?.id ?? null);
    }, [sources, selectedId]);

    const source = sources.find(s => s.id === selectedId) ?? null;
    const camera = cameras.find(c => c.id === selectedId) ?? null;
    const live = sources.filter(s => s.kind === 'camera' && s.active).length;

    // Владелец ищется по ownerId: второй поток 360 в списке источников не значится
    const signalingUrlOf = (sourceId: string, ownerId: string = sourceId) => {
        const owner = sources.find(s => s.id === ownerId)?.deviceId;
        return owner ? signalingWsUrl(owner, `/client/${sourceId}`) : wsUrl(`/signaling/client/${sourceId}`);
    };

    const viewKey = camera ? lightestStream(camera) : undefined;
    const viewStream = camera && viewKey ? camera.streams[viewKey] : undefined;

    // Список камер ещё не пришёл по сокету: место держат скелеты
    const loading = !connected && cameras.length === 0;
    const playable = source && !source.offline && (source.kind === 'virtual' ? source.active : source.viewStreams.length > 0);
    const strip = loading || !playable ? ' is-none' : status === 'streaming' ? '' : status === 'connecting' || status === 'signaling' ? ' is-wait' : ' is-off';

    const renderPlayer = () => {
        if (!source || !playable) return null;
        if (source.kind === 'virtual') {
            return (
                <SurroundCell
                    key={source.id}
                    streamId={source.id}
                    name={source.name}
                    signalingUrl={signalingUrlOf(source.id)}
                    overlays={OVERLAYS}
                    deviceTimeMs={unixMs}
                    collectStats
                    secondary={source.secondary
                        ? { ...source.secondary, signalingUrl: signalingUrlOf(source.secondary.streamId, source.id) }
                        : null}
                    onStatus={setStatus}
                    onStats={setStats}
                />
            );
        }
        return (
            <CellPlayer
                key={source.id}
                cameraId={source.id}
                cameraName={source.name}
                signalingUrl={signalingUrlOf(source.id)}
                streamKey={viewKey}
                canDetect={source.hasNeural}
                canCorrect={false}
                corrected={false}
                onCorrectedChange={() => {}}
                showDetections={source.hasNeural}
                onDetectionsChange={() => {}}
                overlays={OVERLAYS}
                deviceTimeMs={unixMs}
                collectStats
                onStatus={setStatus}
                onStats={setStats}
                controls="none"
            />
        );
    };

    const sourceRow = (src: WallSource) => {
        const cam = src.kind === 'camera' ? cameras.find(c => c.id === src.id) : undefined;
        const main = cam ? mainStream(cam) : undefined;
        const detail = src.offline ? 'устройство не в сети' : src.kind === 'virtual' ? (src.active ? src.detail : 'модуль не запущен') : 'нет потока';
        return (
            <button
                key={src.id}
                className={`m-li${src.id === selectedId ? ' is-on' : ''}${src.active ? '' : ' is-off'}`}
                onClick={() => setSelectedId(src.id)}
            >
                <div className="t">
                    <b>{src.name}</b>
                    {cam && src.active ? (
                        <div className="m-tags">
                            {purposesOf(cam).map(p => (
                                <span key={p} className={`tag ${PURPOSE_TAG[p]!.cls}`}>{PURPOSE_TAG[p]!.label}</span>
                            ))}
                        </div>
                    ) : (
                        <span>{detail}</span>
                    )}
                </div>
                {src.active && main ? (
                    <div className="v">
                        {main.width}×{main.height}
                        <small className="seps"><span>{main.codec}</span><span>{main.fps} к/с</span></small>
                    </div>
                ) : src.active ? (
                    <span className="tag is-ok">в эфире</span>
                ) : (
                    <span className="tag is-err">{src.kind === 'virtual' ? 'остановлен' : 'нет потока'}</span>
                )}
                <span className={`dot ${src.active ? 'ok' : ''}`} />
            </button>
        );
    };

    return (
        <section className="m-screen">
            <div className="m-scroll">
                <div className={`m-vf${loading ? ' is-wait' : ''}`} ref={boxRef}>
                    {loading && <span className="spin" />}
                    {renderPlayer()}
                    {!loading && !source && (
                        <div className="empty">
                            <Icon name="cam" />
                            <b>Камер нет</b>
                            <p>Камеры добавляются на рабочем месте.</p>
                        </div>
                    )}
                    {source && !playable && (
                        <div className="empty">
                            <Icon name={source.kind === 'virtual' ? 'eye' : 'cam'} />
                            <b>{source.name}</b>
                            <p>{source.offline ? 'Устройство не в сети.' : source.kind === 'virtual' ? 'Модуль не запущен.' : 'Нет потока для просмотра.'}</p>
                        </div>
                    )}
                    {source && (
                        <>
                            <div className="m-ov m-ov-tl"><span className={`dot ${source.active ? 'ok' : 'err'}`} />{source.name}</div>
                            <div className="m-ov m-ov-br">
                                <button className="m-vbtn" aria-label="Во весь экран" onClick={() => boxRef.current?.requestFullscreen?.()}>
                                    <Icon name="full" />
                                </button>
                            </div>
                        </>
                    )}
                </div>
                <div className={`m-strip${strip}`} />
                <div className="m-meta">
                    <span><b>{viewStream?.width ? `${viewStream.width}×${viewStream.height}` : source?.kind === 'virtual' ? source.detail : '—'}</b></span>
                    <span><b>{num(stats?.fps, 0)}</b> к/с</span>
                    <span><b>{num(stats?.mbits, 1)}</b> Мбит/с</span>
                    <span className="sp">задержка <b>{num(stats?.rttMs, 0)}</b> мс</span>
                </div>

                <div className="m-grp">Камеры{!loading && <span className="m-sp">{live} / {cameras.length} в эфире</span>}</div>
                <div className="m-cols">
                    {loading && [0, 1, 2, 3].map(i => <SkRow key={i} i={i} />)}
                    {sources.filter(s => s.kind === 'camera').map(sourceRow)}
                </div>

                {(virtual === null || modules.length > 0) && (
                    <>
                        <div className="m-grp">Модули</div>
                        <div className="m-cols">
                            {virtual === null && [0, 1].map(i => <SkRow key={i} i={i} />)}
                            {modules.map(sourceRow)}
                        </div>
                    </>
                )}
            </div>
        </section>
    );
}
