import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../app/Icons';
import { ArchiveFeed } from './feed';
import type { Segment, Track } from './model';
import { fmtTime, isRecorded, runAfter, segmentAt, segmentUrl, trackKey } from './model';

// Проигрывание архива через границы сегментов

interface Props {
    track: Track | null;
    // Сегменты выбранной дорожки — их грузит экран, а не таймлайн
    segments: Segment[];
    // Внешняя перемотка: token меняется на каждый клик по дорожке
    seek: { ms: number; token: number };
    playing: boolean;
    speed: number;
    onProgress: (ms: number) => void;
    onPlayingChange: (playing: boolean) => void;
    onTrackEnd: () => void;
    // Переход к ближайшей записи из пустого места
    onSeekTo: (ms: number) => void;
}

export function ArchivePlayer({
    track, segments: allSegments, seek, playing, speed, onProgress, onPlayingChange, onTrackEnd, onSeekTo,
}: Props) {
    // Список сегментов приезжает позже смены дорожки — чужие не берём
    const segments = useMemo(
        () => (track
            ? allSegments.filter(s => s.camera_id === track.camera_id && s.stream_key === track.stream_key)
            : []),
        [allSegments, track],
    );

    const video = useRef<HTMLVideoElement | null>(null);
    const feed = useRef<ArchiveFeed | null>(null);

    const [current, setCurrent] = useState<Segment | null>(null);
    const [failed, setFailed] = useState(false);
    const [error, setError] = useState('');

    // Колбэки экрана меняются каждый рендер, лента живёт дольше
    const callbacks = useRef({ onProgress, onPlayingChange, onTrackEnd });
    callbacks.current = { onProgress, onPlayingChange, onTrackEnd };
    const playingRef = useRef(playing);
    playingRef.current = playing;
    // load() при пересоздании источника сбрасывает playbackRate — возвращаем после перемотки
    const speedRef = useRef(speed);
    speedRef.current = speed;

    // Лента создаётся на дорожку: у другой дорожки свой MediaSource
    useEffect(() => {
        const element = video.current;
        if (!element || !track) return;

        const instance = new ArchiveFeed(element, segment => segmentUrl(track, segment), {
            onError: message => {
                settling.current = false;
                setError(message);
                setFailed(true);
            },
            onEnd: () => {
                callbacks.current.onPlayingChange(false);
                callbacks.current.onTrackEnd();
            },
        });
        feed.current = instance;

        return () => {
            instance.destroy();
            feed.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track && trackKey(track)]);

    useEffect(() => {
        feed.current?.setSegments(segments);
    }, [segments]);

    // Перемотка в работе: время замораживается, воспроизведение стоит, пока
    // данные на новой позиции не окажутся в буфере — об этом скажет seeked
    const settling = useRef(false);

    const mount = useCallback((segment: Segment, ms: number) => {
        setFailed(false);
        setCurrent(segment);
        settling.current = true;
        video.current?.pause();
        void feed.current?.seek(segment, ms);
    }, []);

    const handleSeeked = useCallback(() => {
        const element = video.current;
        if (element) element.playbackRate = speedRef.current;
        if (!settling.current) return;
        settling.current = false;
        if (playingRef.current && element) {
            element.play().catch(() => callbacks.current.onPlayingChange(false));
        }
    }, []);

    // Что уже поставлено: перемотка и дорожка; повторно тот же клик не монтируется
    const served = useRef<string | null>(null);
    // Клик, под который время уже заморожено в ожидании сегментов
    const frozen = useRef<string | null>(null);

    // Перемотка снаружи: клик по дорожке, смена дорожки, смена дня. Сегменты
    // приезжают окном вокруг курсора и позже клика — эффект ждёт их сам
    useEffect(() => {
        if (!track) {
            setCurrent(null);
            return;
        }

        const key = `${seek.token}/${trackKey(track)}`;
        const target = segmentAt(segments, seek.ms);

        if (target) {
            if (served.current !== key) {
                served.current = key;
                mount(target, seek.ms);
            }
            return;
        }

        // Сегмента ещё нет, но по кускам дорожки запись есть — кадр не гасим,
        // а время замораживаем уже сейчас: иначе плеер утащит курсор обратно,
        // и экран запросит сегменты не вокруг клика, а вокруг старого места
        if (isRecorded(track, seek.ms)) {
            if (frozen.current !== key) {
                frozen.current = key;
                settling.current = true;
                video.current?.pause();
            }
            return;
        }

        // Курсор в пустоте — честно показываем, что записи здесь нет
        if (served.current !== key) {
            served.current = key;
            settling.current = false;
            setCurrent(null);
            setFailed(false);
            feed.current?.park();
        }
    }, [seek.token, seek.ms, segments, track, mount]);

    useEffect(() => {
        const element = video.current;
        if (!element || !current) return;

        element.playbackRate = speedRef.current;
        if (!playing) {
            element.pause();
        } else if (!settling.current) {
            element.play().catch(() => callbacks.current.onPlayingChange(false));
        }
    }, [playing, current]);

    useEffect(() => {
        if (video.current) video.current.playbackRate = speed;
    }, [speed]);

    const handleTimeUpdate = useCallback(() => {
        const instance = feed.current;
        if (!instance || !current) return;

        instance.tick(playingRef.current);

        const ms = instance.positionMs();
        if (ms === null || settling.current) return;
        callbacks.current.onProgress(ms);

        // Эстафета прошла через границу файла — подпись и ошибка про новый
        const at = segmentAt(segments, ms);
        if (at && at.path !== current.path) setCurrent(at);
    }, [current, segments]);

    const handleWaiting = useCallback(() => {
        feed.current?.tick(playingRef.current);
    }, []);

    const stamp = current
        ? `${track?.camera_id ?? ''} · ${fmtTime(current.start_ms)}`
        : '';

    // Записи под курсором нет — кадр гаснет, а не остаётся под надписью.
    // Куда прыгать, считаем по кускам: они есть у дорожки всегда, в отличие
    // от сегментов, которые подгружаются только вокруг курсора
    const nextMs = !current && track ? runAfter(track, seek.ms) : null;

    return (
        <div className="arch-video">
            <video
                ref={video}
                className={`arch-frame${current && !failed ? ' is-on' : ''}`}
                playsInline
                muted
                preload="auto"
                onTimeUpdate={handleTimeUpdate}
                onSeeked={handleSeeked}
                onWaiting={handleWaiting}
                onEnded={() => feed.current?.onEnded()}
                onError={() => {
                    // Событие доезжает позже пересоздания источника — тогда error уже пуст
                    const media = video.current?.error;
                    if (!media) return;
                    setError(media.message);
                    setFailed(true);
                }}
            />

            {current && !failed && <div className="arch-stamp">{stamp}</div>}

            {!current && (
                <div className="arch-empty">
                    <Icon name="arch" />
                    <span>{track ? 'В этот момент записи нет' : 'Выберите дорожку'}</span>
                    {nextMs !== null && (
                        <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => onSeekTo(nextMs)}
                        >
                            Дальше запись в {fmtTime(nextMs)}
                        </button>
                    )}
                </div>
            )}

            {failed && (
                <div className="arch-empty">
                    <Icon name="warn" />
                    <span>Фрагмент не открылся: {current?.file}{error ? ` · ${error}` : ''}</span>
                </div>
            )}
        </div>
    );
}
