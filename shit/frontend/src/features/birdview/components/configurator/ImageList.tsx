import { confState, fmtM, useConfStore } from '../../state/conf-store';
import { confDelete, confSelect } from './conf-actions';

/** Список подложек. Порт _renderImgList. */

export function ImageList() {
    useConfStore();

    return (
        <div className="conf-item-list">
            {confState.images.map(img => (
                <div
                    key={img.id}
                    className={`conf-item ${confState.selected?.id === img.id ? 'selected' : ''}`}
                    onClick={() => confSelect({ type: 'image', id: img.id })}
                >
                    <span className="conf-item-name">{img.name}</span>
                    <span className="conf-item-meta">{fmtM(img.w)}×{fmtM(img.h)} м</span>
                    <button
                        className="conf-item-delete"
                        onClick={e => {
                            e.stopPropagation();
                            confDelete('image', img.id);
                        }}
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
