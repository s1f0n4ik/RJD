import type { SystemInfo } from '../../api/types';
import type { Stream } from './CoresSection';

interface StreamCardProps {
    stream: Stream;
    configOptions: { id: string; name: string }[];
    hasTracker: boolean;
    editable: boolean;
    running: boolean;
    platform: SystemInfo;
    /** Ядра, занятые другими потоками. */
    occupiedCores: Set<number>;
    /** Отображаемое имя выбранной камеры (или null). */
    cameraName: string | null;
    eventTypes: string[];
    eventNames: Record<string, string>;
    onPatch: (patch: Partial<Stream>) => void;
    onToggleCore: (core: number) => void;
    onRemove: () => void;
    onOpenCamera: () => void;
}

export function StreamCard({
    stream,
    configOptions,
    hasTracker,
    editable,
    running,
    platform,
    occupiedCores,
    cameraName,
    eventTypes,
    eventNames,
    onPatch,
    onToggleCore,
    onRemove,
    onOpenCamera,
}: StreamCardProps) {
    const cfgName = configOptions.find((c) => c.id === stream.configId)?.name ?? stream.configId;

    return (
        <div className={`scard${running ? ' running' : ''}`}>
            <div className="scard-head">
                <div>
                    <div className="n">{cfgName}</div>
                    <div className="id">{stream.configId}</div>
                </div>
                {editable && <button className="icon-btn" onClick={onRemove} title="Удалить поток">×</button>}
            </div>

            {/* Конфигурация (в режиме редактирования — можно сменить) */}
            {editable && (
                <label className="field-group">
                    <span className="field-label">Конфигурация</span>
                    <select
                        className="field-input"
                        value={stream.configId}
                        onChange={(e) => onPatch({ configId: e.target.value })}
                    >
                        {configOptions.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </label>
            )}

            <div className="scard-badges">
                {stream.streaming.enabled && <span className="strm-badge live"><span className="d" />стрим</span>}
                {hasTracker && <span className="strm-badge filt"><span className="d" />фильтр</span>}
                {!cameraName && <span className="strm-badge warn"><span className="d" />нет камеры</span>}
                {running && <span className="strm-badge live"><span className="d" />работает</span>}
            </div>

            {/* Ядра — только для платформы с распределением по ядрам */}
            {platform.mode === 'cores' && (
                <div className="field-group">
                    <span className="field-label">Ядра NPU</span>
                    <div className="cores-row">
                        {Array.from({ length: platform.npu_cores }, (_, c) => {
                            const mine = stream.cores.includes(c);
                            const busyOther = occupiedCores.has(c) && !mine;
                            const clickable = editable && !busyOther && (!mine || stream.cores.length > 1);
                            let cls = 'core-pill';
                            if (mine) cls += ' sel-core';
                            else if (busyOther) cls += ' occ';
                            else if (clickable) cls += ' pick';
                            return (
                                <div
                                    key={c}
                                    className={cls}
                                    title={busyOther ? 'занят другим потоком' : undefined}
                                    onClick={() => clickable && onToggleCore(c)}
                                >
                                    <span className="cn">C{c}</span>
                                    <span className="cs">{mine ? 'этот поток' : busyOther ? 'занято' : 'свободно'}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Камера */}
            <div className="strm-sec">
                <div className="cam-head">
                    <span className="field-label">Камера</span>
                    {editable && <button className="btn btn-ghost btn-sm" onClick={onOpenCamera}>настроить</button>}
                </div>
                <div className="wallmini" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
                    <div className={`wm${cameraName ? '' : ' empty'}`}>{cameraName ?? 'камера не выбрана'}</div>
                </div>
            </div>

            {/* Стриминг */}
            <div className="strm-sec">
                <span className="field-label">Стриминг</span>
                <div
                    className={`strm-sw${stream.streaming.enabled ? ' on' : ''}${editable ? '' : ' ro'}`}
                    onClick={() => editable && onPatch({ streaming: { ...stream.streaming, enabled: !stream.streaming.enabled } })}
                >
                    <span className="track" />
                    <span className="sw-lbl">{stream.streaming.enabled ? 'включён' : 'выключен'}</span>
                </div>
                {stream.streaming.enabled && (
                    <input
                        className="field-input"
                        placeholder="отображаемое имя потока"
                        value={stream.streaming.name}
                        disabled={!editable}
                        onChange={(e) => onPatch({ streaming: { ...stream.streaming, name: e.target.value } })}
                    />
                )}
            </div>

            {/* Маска событий — только если у конфигурации есть трекер */}
            {hasTracker && (
                <div className="strm-sec">
                    <span className="field-label">Маска событий</span>
                    <div className="ev-chips">
                        {eventTypes.map((t) => {
                            const on = stream.mask.includes(t);
                            return (
                                <span
                                    key={t}
                                    className={`ev-chip${on ? ' on' : ''}${editable ? '' : ' ro'}`}
                                    onClick={() => {
                                        if (!editable) return;
                                        onPatch({ mask: on ? stream.mask.filter((x) => x !== t) : [...stream.mask, t] });
                                    }}
                                >
                                    {eventNames[t] ?? t}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
