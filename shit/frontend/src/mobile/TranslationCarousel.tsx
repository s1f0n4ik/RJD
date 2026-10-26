import { useEffect, useRef, useState } from 'react';
import { Icon } from '../app/Icons';
import { reducedMotion } from '../app/motion';
import { CellPlayer } from '../screens/live/CellPlayer';
import { SurroundCell } from '../screens/live/SurroundCell';
import type { LayoutState } from '../screens/live/model';
import type { WallSource } from '../screens/live/sources';
import type { PlayerStats, PlayerStatus } from '../components/webrtc/useWebRTCPlayer';
import type { CPPCamera } from '../types';
import { lightestStream } from './CamerasScreen';
import './mobile.css';

// Слайд выбирается, когда прокрутка стоит столько; промежуточные не подключаются
const SETTLE_MS = 150;

// Точек больше не помещается в ширину телефона, остаётся счётчик
const MAX_DOTS = 12;

const OVERLAYS = { name: false, time: false, stats: false, sources: false };

const num = (value: number | null | undefined, digits: number) =>
    (value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ','));

interface Slide {
    key: string;
    // Номер ячейки в отображении; null — отображений нет, листаются все источники
    cell: number | null;
    source: WallSource;
}

interface TranslationCarouselProps {
    layout: LayoutState;
    sources: WallSource[];
    cameras: CPPCamera[];
    loaded: boolean;
    // Отображений нет: листаются все камеры и модули
    all: boolean;
    switchKey: string;
    signalingUrlOf: (sourceId: string, ownerId?: string) => string;
    deviceTimeMs: number | null;
    correctionLinks: Record<string, boolean>;
    onCorrectedChange: (cameraId: string, value: boolean) => void;
    onDetectionsChange: (cameraId: string, value: boolean) => void;
}

function playable(source: WallSource): boolean {
    return !source.offline && (source.kind === 'virtual' ? source.active : source.viewStreams.length > 0);
}

function reason(source: WallSource): string {
    if (source.offline) return `${source.deviceName || 'Устройство'} не в сети`;
    return source.kind === 'virtual' ? 'модуль не запущен' : 'нет потока для просмотра';
}

/** Трансляция на телефоне: ячейки отображения по одной, играет только видимая. */
export function TranslationCarousel({
    layout,
    sources,
    cameras,
    loaded,
    all,
    switchKey,
    signalingUrlOf,
    deviceTimeMs,
    correctionLinks,
    onCorrectedChange,
    onDetectionsChange,
}: TranslationCarouselProps) {
    const boxRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const settleRef = useRef(0);
    const [index, setIndex] = useState(0);
    const [full, setFull] = useState(false);
    const [status, setStatus] = useState<PlayerStatus>('connecting');
    const [stats, setStats] = useState<PlayerStats | null>(null);

    const slides: Slide[] = all
        ? sources.map(source => ({ key: source.id, cell: null, source }))
        : layout.grid.cells.flatMap((cell, i) => {
            const source = sources.find(s => s.id === layout.cells[cell.id]);
            return source ? [{ key: cell.id, cell: i + 1, source }] : [];
        });
    const current = Math.min(index, Math.max(0, slides.length - 1));
    const slide = slides[current];

    // Новое отображение листается с первой ячейки
    useEffect(() => {
        setIndex(0);
        trackRef.current?.scrollTo({ left: 0 });
    }, [switchKey]);

    // Цифры прежнего слайда новому не достаются
    useEffect(() => {
        setStatus('connecting');
        setStats(null);
    }, [slide?.key, switchKey]);

    const viewKeyOf = (source: WallSource) => {
        const camera = cameras.find(c => c.id === source.id);
        return camera ? lightestStream(camera) : undefined;
    };

    useEffect(() => () => window.clearTimeout(settleRef.current), []);

    // Полный экран закрывают и мимо кнопки: жестом «назад» или клавишей
    useEffect(() => {
        const onChange = () => { if (!document.fullscreenElement) setFull(false); };
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const onScroll = () => {
        window.clearTimeout(settleRef.current);
        settleRef.current = window.setTimeout(() => {
            const track = trackRef.current;
            if (track?.clientWidth) setIndex(Math.round(track.scrollLeft / track.clientWidth));
        }, SETTLE_MS);
    };

    const go = (i: number) => {
        const track = trackRef.current;
        track?.scrollTo({ left: i * track.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
    };

    // iPhone не даёт странице полный экран: тогда кадр просто закрывает окно
    const toggleFull = () => {
        if (full) {
            setFull(false);
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
            return;
        }
        setFull(true);
        boxRef.current?.requestFullscreen?.().catch(() => {});
    };

    const renderPlayer = (source: WallSource) => {
        const key = `${source.id}-${switchKey}`;
        if (source.producer === 'birdview') {
            return (
                <SurroundCell
                    key={key}
                    streamId={source.id}
                    name={source.name}
                    signalingUrl={signalingUrlOf(source.id)}
                    overlays={OVERLAYS}
                    deviceTimeMs={deviceTimeMs}
                    collectStats
                    secondary={source.secondary
                        ? { ...source.secondary, signalingUrl: signalingUrlOf(source.secondary.streamId, source.id) }
                        : null}
                    initialViewMode={layout.surround?.viewMode}
                    interactive={false}
                    onStatus={setStatus}
                    onStats={setStats}
                />
            );
        }
        return (
            <CellPlayer
                key={key}
                cameraId={source.id}
                cameraName={source.name}
                signalingUrl={signalingUrlOf(source.id)}
                streamKey={viewKeyOf(source)}
                canDetect={source.hasNeural}
                canCorrect={source.hasBirdview && Boolean(correctionLinks[source.id])}
                corrected={Boolean(layout.corrections[source.id])}
                onCorrectedChange={value => onCorrectedChange(source.id, value)}
                showDetections={Boolean(layout.detections[source.id])}
                onDetectionsChange={value => onDetectionsChange(source.id, value)}
                overlays={OVERLAYS}
                deviceTimeMs={deviceTimeMs}
                collectStats
                onStatus={setStatus}
                onStats={setStats}
                controls="none"
            />
        );
    };

    if (!loaded || slides.length === 0) {
        return (
            <div className="m-car-page">
                <div className={`m-car m-car-blank${loaded ? '' : ' is-wait'}`}>
                    {loaded ? (
                        <div className="empty">
                            <Icon name="cam" />
                            <b>{all ? 'Камер нет' : 'Отображение пустое'}</b>
                            <p>{all ? 'Камеры добавляются на рабочем месте.' : 'В ячейках нет ни одного источника.'}</p>
                        </div>
                    ) : <span className="spin" />}
                </div>
            </div>
        );
    }

    const live = slide && playable(slide.source);
    const camera = slide && cameras.find(c => c.id === slide.source.id);
    const viewKey = slide && viewKeyOf(slide.source);
    const viewStream = camera && viewKey ? camera.streams[viewKey] : undefined;
    const strip = !live ? ' is-none' : status === 'streaming' ? '' : status === 'connecting' || status === 'signaling' ? ' is-wait' : ' is-off';

    return (
        <div className="m-car-page">
            <div className={`m-car${full ? ' is-full' : ''}`} ref={boxRef}>
                <div className="m-car-track" ref={trackRef} onScroll={onScroll}>
                    {slides.map((item, i) => (
                        <div key={item.key} className="m-car-slide">
                            {i !== current ? (
                                <div className="m-car-idle">
                                    <Icon name={item.source.producer === 'birdview' ? '360' : 'cam'} />
                                    {item.source.name}
                                </div>
                            ) : playable(item.source) ? renderPlayer(item.source) : (
                                <div className="empty">
                                    <Icon name={item.source.kind === 'virtual' ? 'eye' : 'cam'} />
                                    <b>{item.source.name}</b>
                                    <p>{reason(item.source)}.</p>
                                </div>
                            )}
                            <div className="m-ov m-ov-tl">
                                <span className={`dot ${item.source.active ? 'ok' : 'err'}`} />
                                {item.source.name}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="m-car-ov">
                    <span className="m-car-cnt">{current + 1} / {slides.length}</span>
                    {slides.length <= MAX_DOTS && (
                        <div className="m-car-dots">
                            {slides.map((item, i) => (
                                <i key={item.key} className={i === current ? 'is-on' : item.source.active ? '' : 'is-off'} />
                            ))}
                        </div>
                    )}
                    <button className="m-vbtn" aria-label={full ? 'Свернуть' : 'Во весь экран'} onClick={toggleFull}>
                        <Icon name={full ? 'unfull' : 'full'} />
                    </button>
                </div>
            </div>

            <div className={`m-strip${strip}`} />
            <div className="m-meta">
                <span><b>{viewStream?.width ? `${viewStream.width}×${viewStream.height}` : slide?.source.kind === 'virtual' ? slide.source.detail : '—'}</b></span>
                <span><b>{num(stats?.fps, 0)}</b> к/с</span>
                <span><b>{num(stats?.mbits, 1)}</b> Мбит/с</span>
                <span className="sp">задержка <b>{num(stats?.rttMs, 0)}</b> мс</span>
            </div>

            <div className="m-grp">{all ? 'Камеры и модули' : 'Ячейки отображения'}<span className="m-sp">{slides.length}</span></div>
            {slides.map((item, i) => (
                <button
                    key={item.key}
                    className={`m-li${i === current ? ' is-on' : ''}${item.source.active ? '' : ' is-off'}`}
                    onClick={() => go(i)}
                >
                    {item.cell !== null && <span className="m-car-cell">яч. {item.cell}</span>}
                    <div className="t">
                        <b>{item.source.name}</b>
                        <span>{playable(item.source)
                            ? (item.source.kind === 'virtual'
                                ? item.source.detail
                                : item.source.viewStreams.find(s => s.key === viewKeyOf(item.source))?.label)
                            : reason(item.source)}</span>
                    </div>
                    <span className={`dot ${item.source.active ? 'ok' : 'err'}`} />
                </button>
            ))}
        </div>
    );
}
