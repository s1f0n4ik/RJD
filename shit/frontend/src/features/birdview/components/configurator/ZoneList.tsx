import { Icon } from '../../../../app/Icons';
import { confState, useConfStore } from '../../state/conf-store';
import { zoneCameras } from './conf-canvas';
import { confDelete, confSelect } from './conf-actions';

// Список матов. Номер — позиция в списке

export function ZoneList() {
    useConfStore();

    return (
        <>
            {confState.zones.map((zone, index) => {
                const cams = zoneCameras(zone);
                const isSelected = confState.selected?.id === zone.id;

                return (
                    <div
                        key={zone.id}
                        className={`zrow${isSelected ? ' is-sel' : ''}`}
                        onClick={() => confSelect({ type: 'zone', id: zone.id })}
                    >
                        <span className="n">{index + 1}</span>
                        <span className="nm">{zone.name}</span>
                        <span className="tags">
                            {cams.length ? (
                                cams.map(cam => (
                                    <span key={cam.id} className="tag">{cam.key}</span>
                                ))
                            ) : (
                                <span className="tag is-warn">вне камер</span>
                            )}
                        </span>
                        <button
                            className="icon-btn x"
                            onClick={e => {
                                e.stopPropagation();
                                confDelete('zone', zone.id);
                            }}
                        >
                            <Icon name="x" size={12} className="" />
                        </button>
                    </div>
                );
            })}
        </>
    );
}
