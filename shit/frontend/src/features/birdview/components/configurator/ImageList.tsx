import { Icon } from '../../../../app/Icons';
import { confState, useConfStore } from '../../state/conf-store';
import { confDelete, confSelect } from './conf-actions';

// Список подложек: имя файла и размер исходника в пикселях

export function ImageList() {
    useConfStore();

    return (
        <>
            {confState.images.map(img => (
                <div
                    key={img.id}
                    className={`zrow${confState.selected?.id === img.id ? ' is-sel' : ''}`}
                    onClick={() => confSelect({ type: 'image', id: img.id })}
                >
                    <span className="cam-icon img">
                        <Icon name="img" size={12} className="" />
                    </span>
                    <span className="nm">{img.name}</span>
                    <span className="key">{img.img.naturalWidth}×{img.img.naturalHeight}</span>
                    <button
                        className="icon-btn x"
                        onClick={e => {
                            e.stopPropagation();
                            confDelete('image', img.id);
                        }}
                    >
                        <Icon name="x" size={12} className="" />
                    </button>
                </div>
            ))}
        </>
    );
}
