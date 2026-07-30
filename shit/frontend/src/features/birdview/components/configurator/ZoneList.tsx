import { confState, useConfStore } from '../../state/conf-store';
import { zoneCameras } from './conf-canvas';
import { confDelete, confSelect } from './conf-actions';

/** Список разметочных зон. Номер глобальный — позиция в списке. */

export function ZoneList() {
    useConfStore();

    return (
        <div className="conf-item-list">
            {confState.zones.map((zone, index) => {
                const cams = zoneCameras(zone);
                const isSelected = confState.selected?.id === zone.id;

                return (
                    <div
                        key={zone.id}
                        className={`conf-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => confSelect({ type: 'zone', id: zone.id })}
                    >
                        <div className="conf-item-color" style={{ background: zone.color }} />
                        <div className="conf-item-name-col">
                            <span className="conf-item-name">#{index + 1} · {zone.name}</span>
                            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                {cams.length ? (
                                    cams.map(cam => (
                                        <span
                                            key={cam.id}
                                            className="conf-item-cam-tag"
                                            style={{ borderColor: cam.color, color: cam.color }}
                                        >
                                            {cam.name}
                                        </span>
                                    ))
                                ) : (
                                    <span className="conf-item-cam-tag">вне камер</span>
                                )}
                            </span>
                        </div>
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
