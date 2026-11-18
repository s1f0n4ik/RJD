import { useEffect, useState } from 'react';
import { Seg } from '../../app/Modal';
import { Select } from '../../app/Select';
import { api } from '../../services/api';
import type { LocalCamera, V4l2Source } from '../../types';
import { Cell } from './CameraFields';
import { V4L2_ROTATIONS, formatError, modeFor, rotationAllowed } from './model';

// Число из поля ввода; не число — 0
const toInt = (raw: string): number => {
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
};

export interface LocalCamerasState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    cameras: LocalCamera[];
    error: string;
    reload: () => void;
}

/** Камеры платы из media-center устройства; enabled — опрашивать ли сейчас. */
export function useLocalCameras(deviceId: string, enabled: boolean): LocalCamerasState {
    const [state, setState] = useState<Omit<LocalCamerasState, 'reload'>>({ status: 'idle', cameras: [], error: '' });
    const [round, setRound] = useState(0);

    useEffect(() => {
        if (!enabled || !deviceId) return;
        let alive = true;
        setState(prev => ({ ...prev, status: 'loading' }));
        api.getLocalCameras(deviceId)
            .then(cameras => alive && setState({ status: 'ready', cameras, error: '' }))
            .catch(err => alive && setState({ status: 'error', cameras: [], error: formatError(err) }));
        return () => { alive = false; };
    }, [deviceId, enabled, round]);

    return { ...state, reload: () => setRound(n => n + 1) };
}

/** Название камеры платы: у CSI — модель сенсора подсказкой. */
export function LocalCameraTitle({ camera }: { camera: LocalCamera }) {
    if (camera.kind !== 'csi') return <>{camera.name}</>;
    return (
        <span className="seps">
            <span>Камера CSI</span>
            {camera.sensor && <span className="lc-sensor">{camera.sensor}</span>}
        </span>
    );
}

interface LocalCameraListProps {
    list: LocalCamerasState;
    deviceName: string;
    // Адрес выбранной камеры
    value: string;
    // Своя камера: её устройство не считается занятым
    ownerId?: string;
    onPick: (camera: LocalCamera) => void;
}

/** Камеры платы списком: выбор, занятые, опрос, пусто и ошибка. */
export function LocalCameraList({ list, deviceName, value, ownerId, onPick }: LocalCameraListProps) {
    if (list.status === 'loading' || list.status === 'idle') {
        return <div className="lc-state"><span className="spin" />Опрашиваем камеры на «{deviceName}»…</div>;
    }
    if (list.status === 'error') {
        return <div className="lc-state is-err"><b>Плата не ответила</b>{list.error}</div>;
    }
    if (list.cameras.length === 0) {
        return <div className="lc-state"><b>На плате нет камер USB и CSI</b>Подключите камеру к плате и нажмите «Обновить»</div>;
    }

    return (
        <div className="lc-list">
            {list.cameras.map(camera => {
                const busy = !!camera.used_by && camera.used_by !== ownerId;
                const address = camera.kind === 'csi' ? `${camera.device} · ${camera.node}` : camera.device;
                return (
                    <button
                        key={camera.device}
                        type="button"
                        className={`lc-item${camera.device === value ? ' is-on' : ''}`}
                        disabled={busy}
                        onClick={() => onPick(camera)}
                    >
                        <span className="lc-kind">{camera.kind.toUpperCase()}</span>
                        <span className="lc-who">
                            <span className="n"><LocalCameraTitle camera={camera} /></span>
                            <span className="a"><bdi>{address}</bdi></span>
                        </span>
                        {busy ? (
                            <span className="lc-st st st-warn"><span className="dot warn" />занята {camera.used_by}</span>
                        ) : (
                            <span className="lc-st st st-ok"><span className="dot ok" />свободна</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

interface ModeFieldsProps {
    value: V4l2Source;
    // Возможности камеры; пусто — камеры нет в списке платы, поля вводятся числами
    camera?: LocalCamera;
    onChange: (next: V4l2Source) => void;
}

/** Формат, кадр, частота, поворот и цвет камеры на плате. */
export function ModeFields({ value, camera, onChange }: ModeFieldsProps) {
    const formats = camera?.formats.map(f => f.format) ?? [value.format];
    const format = camera?.formats.find(f => f.format === value.format);
    const sizes = format?.sizes;
    const size = sizes?.find(s => s.width === value.width && s.height === value.height);
    const patch = (next: Partial<V4l2Source>) => onChange({ ...value, ...next });
    const range = format?.range;

    return (
        <>
            <div className="lc-grid lc-grid--3">
                <div className="fcell">
                    <span className="fcap">Формат</span>
                    <Seg className="lc-seg">
                        {formats.map(f => (
                            <button
                                key={f}
                                type="button"
                                className={f === value.format ? 'is-on' : ''}
                                onClick={() => camera ? onChange(modeFor(camera, f, value)) : patch({})}
                            >
                                {f}
                            </button>
                        ))}
                    </Seg>
                </div>

                {sizes ? (
                    <>
                        <Cell cap="Кадр">
                            <Select
                                value={`${value.width}x${value.height}`}
                                onChange={v => {
                                    const [width, height] = v.split('x').map(Number);
                                    const rates = sizes.find(s => s.width === width && s.height === height)?.fps ?? [];
                                    patch({ width, height, fps: rates.length && !rates.includes(value.fps) ? rates[0] : value.fps });
                                }}
                                options={sizes.map(s => ({ value: `${s.width}x${s.height}`, label: `${s.width} × ${s.height}` }))}
                            />
                        </Cell>
                        {size && size.fps.length > 0 ? (
                            <Cell cap="Кадров/с">
                                <Select
                                    value={String(value.fps)}
                                    onChange={v => patch({ fps: Number(v) })}
                                    options={size.fps.map(rate => ({ value: String(rate), label: String(rate) }))}
                                />
                            </Cell>
                        ) : (
                            <Cell cap="Кадров/с">
                                <input className="inp inp--num" value={value.fps} onChange={e => patch({ fps: toInt(e.target.value) })} />
                            </Cell>
                        )}
                    </>
                ) : (
                    <>
                        <label className="fcell">
                            <span className="fcap">Кадр, пикс.</span>
                            <span className="lc-pair">
                                <input className="inp inp--num" value={value.width} onChange={e => patch({ width: toInt(e.target.value) })} />
                                <i>×</i>
                                <input className="inp inp--num" value={value.height} onChange={e => patch({ height: toInt(e.target.value) })} />
                            </span>
                            {range && (
                                <span className="lc-range">
                                    {range.min_width}…{range.max_width} × {range.min_height}…{range.max_height}, шаг {range.step_width}
                                </span>
                            )}
                        </label>
                        <Cell cap="Кадров/с">
                            <input className="inp inp--num" value={value.fps} onChange={e => patch({ fps: toInt(e.target.value) })} />
                        </Cell>
                    </>
                )}
            </div>

            <div className="lc-grid lc-grid--rot">
                <div className="fcell">
                    <span className="fcap lc-cap">
                        Поворот
                        {camera?.kind === 'csi' && value.rotation === 180 && <span className="tag is-acc">сенсором</span>}
                    </span>
                    <Seg className="lc-seg">
                        {V4L2_ROTATIONS.map(angle => {
                            const allowed = rotationAllowed(value, angle);
                            return (
                                <button
                                    key={angle}
                                    type="button"
                                    className={angle === value.rotation ? 'is-on' : ''}
                                    disabled={!allowed}
                                    data-tip={allowed ? undefined : `${value.format} не поворачивается: выберите MJPG или NV12`}
                                    onClick={() => patch({ rotation: angle })}
                                >
                                    {angle}°
                                </button>
                            );
                        })}
                    </Seg>
                </div>
                {value.format !== 'MJPG' && (
                    <div className="fcell">
                        <span className="fcap">Цвет</span>
                        <Seg className="lc-seg">
                            <button type="button" className={value.swap_uv ? '' : 'is-on'} onClick={() => patch({ swap_uv: false })}>Как есть</button>
                            <button type="button" className={value.swap_uv ? 'is-on' : ''} onClick={() => patch({ swap_uv: true })}>U ↔ V</button>
                        </Seg>
                    </div>
                )}
            </div>
        </>
    );
}

interface LocalCameraEditProps {
    value: V4l2Source;
    deviceId: string;
    // Камера, которую правят: её устройство не считается занятым
    ownerId: string;
    onChange: (next: V4l2Source) => void;
}

/** Правка камеры на плате в шторке: камера платы, режим, кодирование. */
export function LocalCameraEdit({ value, deviceId, ownerId, onChange }: LocalCameraEditProps) {
    const list = useLocalCameras(deviceId, true);
    const camera = list.cameras.find(c => c.device === value.device);
    const options = list.cameras.map(c => ({
        value: c.device,
        label: c.kind === 'csi' ? 'Камера CSI' : c.name,
        disabled: !!c.used_by && c.used_by !== ownerId,
        hint: c.used_by && c.used_by !== ownerId ? `занята ${c.used_by}` : c.kind === 'csi' ? c.sensor || c.node : c.node,
    }));
    if (!camera) {
        options.unshift({ value: value.device, label: value.device, disabled: false, hint: list.status === 'loading' ? 'опрашиваем плату' : 'нет на плате' });
    }

    return (
        <>
            <Cell cap="Камера платы">
                <Select
                    value={value.device}
                    onChange={device => {
                        const next = list.cameras.find(c => c.device === device);
                        if (next) onChange(modeFor(next, value.format, value));
                    }}
                    options={options}
                />
            </Cell>
            {list.status === 'error' && <p className="hint is-err" style={{ margin: 0 }}>{list.error}</p>}
            <ModeFields value={value} camera={camera} onChange={onChange} />
            <EncodeFields value={value} onChange={onChange} />
        </>
    );
}

/** Битрейт и интервал опорных кадров кодера камеры на плате. */
export function EncodeFields({ value, onChange }: { value: V4l2Source; onChange: (next: V4l2Source) => void }) {
    return (
        <div className="lc-grid lc-grid--2">
            <Cell cap="Битрейт, кбит/с">
                <input
                    className="inp inp--num"
                    value={value.bitrate || ''}
                    placeholder="4000"
                    onChange={e => onChange({ ...value, bitrate: toInt(e.target.value) })}
                />
            </Cell>
            <Cell cap="Опорный кадр, с">
                <input className="inp inp--num" value={value.gop} onChange={e => onChange({ ...value, gop: toInt(e.target.value) })} />
            </Cell>
        </div>
    );
}
