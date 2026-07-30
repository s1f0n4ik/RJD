import { useBackdropClose } from '../../hooks/useBackdropClose';
import { confState, fmtM, useConfStore } from '../../state/conf-store';
import { confDelete, confRenameCamera } from './conf-actions';
import type { ConfItemType } from '../../types';

// Окно элемента по правой кнопке. У камеры правится только отображаемое имя:
// ключ — это place_key, под ним линкер держит привязку, а сервер переносит
// src_points из прежней записи пресета.

interface ElementModalProps {
    type: ConfItemType;
    id: string;
    onClose: () => void;
}

export function ElementModal({ type, id, onClose }: ElementModalProps) {
    const backdrop = useBackdropClose(onClose);

    useConfStore();

    const cam = type === 'camera' ? confState.cameras.find(c => c.id === id) : undefined;
    const zone = type === 'zone' ? confState.zones.find(z => z.id === id) : undefined;
    const img = type === 'image' ? confState.images.find(i => i.id === id) : undefined;

    const title = cam?.name ?? zone?.name ?? img?.name ?? '';
    if (!cam && !zone && !img) return null;

    const handleDelete = () => {
        confDelete(type, id);
        onClose();
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal-window" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-body" style={{ gap: 14 }}>
                    {cam && (
                        <>
                            <div className="field-group">
                                <label className="field-label">Имя</label>
                                <input
                                    className="field-input"
                                    type="text"
                                    value={cam.name}
                                    onChange={e => confRenameCamera(cam.id, { name: e.target.value })}
                                    onBlur={e => confRenameCamera(cam.id, { name: e.target.value.trim() })}
                                />
                            </div>
                            <div className="field-group">
                                <label className="field-label">Ключ места</label>
                                <span className="modal-stat-value">{cam.key}</span>
                            </div>
                            <div className="field-group">
                                <label className="field-label">Размер</label>
                                <span className="modal-stat-value">
                                    {fmtM(cam.w)}×{fmtM(cam.h)} м
                                </span>
                            </div>
                        </>
                    )}

                    {zone && (
                        <div className="field-group">
                            <label className="field-label">Разметка</label>
                            <span className="modal-stat-value">{fmtM(zone.w)} м</span>
                        </div>
                    )}

                    {img && (
                        <div className="field-group">
                            <label className="field-label">Размер</label>
                            <span className="modal-stat-value">
                                {fmtM(img.w)}×{fmtM(img.h)} м
                            </span>
                        </div>
                    )}
                </div>

                <div className="modal-footer">
                    <button className="btn btn-danger" onClick={handleDelete}>Удалить</button>
                    <button className="btn btn-ghost" onClick={onClose}>Готово</button>
                </div>
            </div>
        </div>
    );
}
