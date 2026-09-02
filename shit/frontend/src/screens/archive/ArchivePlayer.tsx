import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../../app/Icons';
import type { Segment, Track } from './model';
import { fmtTime, segmentAfter, segmentAt, segmentUrl } from './model';

/*
    Проигрывание архива через границы сегментов.

    Файлов много и они короткие, поэтому играют два <video> по очереди: пока
    один показывает текущий фрагмент, второй уже загрузил следующий и стоит на
    нулевом кадре. На стыке меняется только видимость — ни паузы, ни черноты.
*/

interface Props {
    track: Track | null;
    /** Внешняя перемотка: token меняется на каждый клик по дорожке. */
    seek: { ms: number; token: number };
    playing: boolean;
    speed: number;
    onProgress: (ms: number) => void;
    onPlayingChange: (playing: boolean) => void;
    onTrackEnd: () => void;
}

// За сколько до конца фрагмента поднимать следующий
const PRELOAD_LEAD_SEC = 3;

export function ArchivePlayer({
    track, seek, playing, speed, onProgress, onPlayingChange, onTrackEnd,
}: Props) {
    const videoA = useRef<HTMLVideoElement | null>(null);
    const videoB = useRef<HTMLVideoElement | null>(null);

    const [active, setActive] = useState(0);
    const [current, setCurrent] = useState<Segment | null>(null);
    const [failed, setFailed] = useState(false);

    // Что заряжено в резервный элемент — чтобы не грузить одно и то же дважды
    const standbySegment = useRef<Segment | null>(null);

    const elementAt = useCallback(
        (index: number) => (index === 0 ? videoA.current : videoB.current),
        [],
    );

    /** Поставить фрагмент в элемент и перемотать внутрь него. */
    const mount = useCallback((index: number, segment: Segment, offsetMs: number) => {
        const element = elementAt(index);
        if (!element || !track) return;

        const url = segmentUrl(track, segment);
        if (element.dataset.path !== segment.path) {
            element.dataset.path = segment.path;
            element.src = url;
            element.load();
        }

        const offsetSec = Math.max(0, offsetMs / 1000);
        const applyOffset = () => {
            try {
                element.currentTime = offsetSec;
            } catch {
                // Метаданные ещё не подъехали — сработает по loadedmetadata
            }
        };

        if (element.readyState >= 1) applyOffset();
        else element.addEventListener('loadedmetadata', applyOffset, { once: true });
    }, [elementAt, track]);

    /** Зарядить следующий фрагмент в резервный элемент. */
    const preloadNext = useCallback((afterSegment: Segment) => {
        if (!track) return;

        const next = segmentAfter(track, afterSegment.end_ms);
        if (!next || standbySegment.current?.path === next.path) return;

        standbySegment.current = next;
        mount(active === 0 ? 1 : 0, next, 0);
    }, [active, mount, track]);

    // Перемотка снаружи: клик по дорожке, смена дорожки, смена дня
    useEffect(() => {
        if (!track) {
            setCurrent(null);
            return;
        }

        const target = segmentAt(track, seek.ms) || segmentAfter(track, seek.ms);
        if (!target) {
            setCurrent(null);
            return;
        }

        const offset = Math.max(0, seek.ms - target.start_ms);
        setFailed(false);
        setCurrent(target);
        standbySegment.current = null;
        mount(active, target, offset);
        preloadNext(target);
        // active намеренно не в зависимостях: смена активного элемента — это
        // стык эстафеты, перемонтировать по нему ничего не надо
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seek.token, track]);

    // Пуск и пауза идут только активному элементу
    useEffect(() => {
        const element = elementAt(active);
        if (!element || !current) return;

        if (playing) {
            element.play().catch(() => onPlayingChange(false));
        } else {
            element.pause();
        }
    }, [playing, active, current, elementAt, onPlayingChange]);

    useEffect(() => {
        const element = elementAt(active);
        if (element) element.playbackRate = speed;
    }, [speed, active, elementAt]);

    const handleTimeUpdate = useCallback((index: number) => {
        if (index !== active || !current) return;

        const element = elementAt(index);
        if (!element) return;

        onProgress(current.start_ms + element.currentTime * 1000);

        const left = (element.duration || 0) - element.currentTime;
        if (Number.isFinite(left) && left <= PRELOAD_LEAD_SEC) preloadNext(current);
    }, [active, current, elementAt, onProgress, preloadNext]);

    /** Фрагмент кончился — передаём эстафету, а через разрыв прыгаем. */
    const handleEnded = useCallback((index: number) => {
        if (index !== active || !track || !current) return;

        const next = standbySegment.current || segmentAfter(track, current.end_ms);
        if (!next) {
            onPlayingChange(false);
            onTrackEnd();
            return;
        }

        const nextIndex = active === 0 ? 1 : 0;
        if (standbySegment.current?.path !== next.path) {
            mount(nextIndex, next, 0);
        }

        standbySegment.current = null;
        setCurrent(next);
        setActive(nextIndex);
        onProgress(next.start_ms);
    }, [active, current, mount, onPlayingChange, onProgress, onTrackEnd, track]);

    const stamp = current
        ? `${track?.camera_id ?? ''} · ${fmtTime(current.start_ms)}`
        : '';

    return (
        <div className="arch-video">
            <video
                ref={videoA}
                className={`arch-frame${active === 0 ? ' is-on' : ''}`}
                playsInline
                muted
                preload="auto"
                onTimeUpdate={() => handleTimeUpdate(0)}
                onEnded={() => handleEnded(0)}
                onError={() => active === 0 && setFailed(true)}
            />
            <video
                ref={videoB}
                className={`arch-frame${active === 1 ? ' is-on' : ''}`}
                playsInline
                muted
                preload="auto"
                onTimeUpdate={() => handleTimeUpdate(1)}
                onEnded={() => handleEnded(1)}
                onError={() => active === 1 && setFailed(true)}
            />

            {current && !failed && <div className="arch-stamp">{stamp}</div>}

            {!current && (
                <div className="arch-empty">
                    <Icon name="arch" />
                    <span>{track ? 'За этот момент записи нет' : 'Выберите дорожку'}</span>
                </div>
            )}

            {failed && (
                <div className="arch-empty">
                    <Icon name="warn" />
                    <span>Фрагмент не открылся: {current?.file}</span>
                </div>
            )}
        </div>
    );
}
