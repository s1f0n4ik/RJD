import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { Anchor } from '../../app/popover';
import { usePopover } from '../../app/popover';
import type { Track } from './model';
import {
    estimateBytes, fmtBytes, fmtDuration, fmtTime, gapsWithin, recordedWithin, trackKey,
} from './model';

// Окошко диапазона: в обычном режиме одна камера, в полноэкранном список дорожек
interface Props {
    anchor: Anchor;
    range: { from: number; to: number };
    tracks: Track[];
    selected: Track | null;
    cameraNames: Map<string, string>;
    // Полноэкранный режим: список дорожек вместо одной камеры
    multi: boolean;
    onCancel: () => void;
    onDownload: () => void;
}

interface Piece {
    track: Track;
    name: string;
    recorded: number;
    bytes: number;
    missing: number;
}

function measure(track: Track, from: number, to: number, name: string): Piece {
    const recorded = recordedWithin(track, from, to);
    return {
        track,
        name,
        recorded,
        bytes: estimateBytes(track, recorded),
        missing: gapsWithin(track, from, to).length ? to - from - recorded : 0,
    };
}

export function RangeCard({
    anchor, range, tracks, selected, cameraNames, multi, onCancel, onDownload,
}: Props) {
    const ref = usePopover<HTMLDivElement>(anchor, { side: 'top', align: 'center' });
    const [off, setOff] = useState<Set<string>>(new Set());

    // Новый диапазон — снова все дорожки включены
    useEffect(() => setOff(new Set()), [range.from, range.to]);

    const name = (track: Track) => cameraNames.get(track.camera_id) || track.camera_id;

    const pieces = useMemo(() => tracks
        .map(track => measure(track, range.from, range.to, name(track)))
        .filter(piece => piece.recorded > 0),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tracks, range.from, range.to, cameraNames]);

    const one = selected ? measure(selected, range.from, range.to, name(selected)) : null;

    const chosen = pieces.filter(piece => !off.has(trackKey(piece.track)));
    const totalBytes = chosen.reduce((sum, piece) => sum + piece.bytes, 0);
    const totalRecorded = chosen.reduce((sum, piece) => sum + piece.recorded, 0);

    const toggle = (key: string) => setOff(current => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

    return createPortal(
        <div className="rc" ref={ref}>
            <div className="rc-head">
                <b>{fmtTime(range.from)} — {fmtTime(range.to)}</b>
                <span>{fmtDuration(range.to - range.from)}</span>
            </div>

            {multi ? (
                <>
                    <div className="rc-list">
                        {pieces.map(piece => {
                            const key = trackKey(piece.track);
                            const on = !off.has(key);

                            return (
                                <button
                                    type="button"
                                    key={key}
                                    className={`rc-item${on ? ' is-on' : ''}`}
                                    onClick={() => toggle(key)}
                                >
                                    <i className="rc-chk" />
                                    <span className="rc-item-nm">{piece.name}</span>
                                    <span className="rc-item-f">{fmtDuration(piece.recorded)}</span>
                                    <span className="rc-item-f">{fmtBytes(piece.bytes)}</span>
                                </button>
                            );
                        })}

                        {!pieces.length && (
                            <div className="rc-none">В диапазон не попала ни одна запись</div>
                        )}
                    </div>

                    <div className="rc-row">
                        <span>Потоков</span>
                        <b>{chosen.length}</b>
                    </div>
                    <div className="rc-row">
                        <span>В записи</span>
                        <b>{fmtDuration(totalRecorded)}</b>
                    </div>
                    <div className="rc-row">
                        <span>Размер архива</span>
                        <b>≈ {fmtBytes(totalBytes)}</b>
                    </div>

                    <div className="rc-foot">
                        <button type="button" className="btn btn--sm" onClick={onCancel}>Отменить</button>
                        <button type="button" className="btn btn--sm btn--acc" onClick={onDownload}>
                            Скачать
                        </button>
                    </div>
                </>
            ) : (
                <>
                    <div className="rc-cam">{one ? one.name : 'Дорожка не выбрана'}</div>

                    <div className="rc-row">
                        <span>В записи</span>
                        <b>{fmtDuration(one?.recorded ?? 0)}</b>
                    </div>
                    <div className="rc-row">
                        <span>Размер</span>
                        <b>≈ {fmtBytes(one?.bytes ?? 0)}</b>
                    </div>
                    {!!one?.missing && (
                        <div className="rc-row is-warn">
                            <span>Короче на</span>
                            <b>{fmtDuration(one.missing)}</b>
                        </div>
                    )}

                    <div className="rc-foot">
                        <button type="button" className="btn btn--sm" onClick={onCancel}>Отменить</button>
                        <button type="button" className="btn btn--sm btn--acc" onClick={onDownload}>
                            Скачать
                        </button>
                    </div>
                </>
            )}
        </div>,
        document.body,
    );
}
