import { confState, useConfStore } from '../../state/conf-store';
import { confDelete, confSelect } from './conf-actions';

/** Список разметочных зон. Порт _renderZoneList. */

export function ZoneList() {
    useConfStore();

    return (
        <div className="conf-item-list">
            {confState.zones.map(zone => {
                const cam = confState.cameras.find(c => c.id === zone.cameraId);
                const camZones = confState.zones.filter(z => z.cameraId === zone.cameraId);
                const indexInCam = camZones.indexOf(zone) + 1;
                const isSelected = confState.selected?.id === zone.id;

                return (
                    <div
                        key={zone.id}
                        className={`conf-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => confSelect({ type: 'zone', id: zone.id })}
                    >
                        <div className="conf-item-color" style={{ background: zone.color }} />
                        <div className="conf-item-name-col">
                            <span className="conf-item-name">{zone.name}</span>
                            <span
                                className="conf-item-cam-tag"
                                style={{
                                    borderColor: cam?.color ?? 'var(--bv-border)',
                                    color: cam?.color ?? 'var(--bv-text-dim)',
                                }}
                            >
                                #{indexInCam} · {cam?.name ?? '—'}
                            </span>
                        </div>
                        <span className="conf-item-meta">{zone.rotation}°</span>
                        <button
                            className="conf-item-delete"
                            onClick={e => {
                                e.stopPropagation();
                                confDelete('zone', zone.id);
                            }}
                        >
                            ✕
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
