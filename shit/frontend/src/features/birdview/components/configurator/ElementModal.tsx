import { Modal } from '../../../../app/Modal';
import { confState, fmtM, useConfStore } from '../../state/conf-store';
import { confDelete, confRenameCamera } from './conf-actions';
import type { ConfItemType } from '../../types';

// Окно элемента по правой кнопке. У камеры правится только имя: ключ — это
// place_key, под ним линкер держит привязку и переносит src_points

interface ElementModalProps {
    type: ConfItemType;
    id: string;
    onClose: () => void;
}

const TITLE: Record<ConfItemType, string> = {
    camera: 'Камера',
    zone: 'Разметка',
    image: 'Рисунок',
    gabarit: 'Габарит',
};

export function ElementModal({ type, id, onClose }: ElementModalProps) {
    useConfStore();

    const cam = type === 'camera' ? confState.cameras.find(c => c.id === id) : undefined;
    const zone = type === 'zone' ? confState.zones.find(z => z.id === id) : undefined;
    const img = type === 'image' ? confState.images.find(i => i.id === id) : undefined;

    if (!cam && !zone && !img) return null;

    const handleDelete = () => {
        confDelete(type, id);
        onClose();
    };

    return (
        <Modal
            title={TITLE[type]}
            onClose={onClose}
            footer={
                <>
                    <button className="btn btn--err" onClick={handleDelete}>Удалить</button>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Готово</button>
                </>
            }
        >
            <div className="modal-b conf-modal-b">
                {cam && (
                    <>
                        <div className="tf">
                            <span className="tf-cap">Имя</span>
                            <input
                                className="tf-in"
                                type="text"
                                value={cam.name}
                                onChange={e => confRenameCamera(cam.id, { name: e.target.value })}
                                onBlur={e => confRenameCamera(cam.id, { name: e.target.value.trim() })}
                            />
                        </div>
                        <div>
                            <div className="kv"><span className="k">Ключ</span><span className="v">{cam.key}</span></div>
                            <div className="kv"><span className="k">Размер</span><span className="v">{fmtM(cam.w)} × {fmtM(cam.h)} м</span></div>
                        </div>
                    </>
                )}

                {zone && (
                    <div>
                        <div className="kv"><span className="k">Имя</span><span className="v">{zone.name}</span></div>
                        <div className="kv"><span className="k">Сторона</span><span className="v">{fmtM(zone.w)} м</span></div>
                    </div>
                )}

                {img && (
                    <div>
                        <div className="kv"><span className="k">Файл</span><span className="v">{img.name}</span></div>
                        <div className="kv"><span className="k">Размер</span><span className="v">{fmtM(img.w)} × {fmtM(img.h)} м</span></div>
                    </div>
                )}
            </div>
        </Modal>
    );
}
