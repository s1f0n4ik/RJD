import { confState, useConfStore } from '../../state/conf-store';
import { confDelete, confRenameCamera, confSelect } from './conf-actions';

/** Список камер с инлайновой правкой ключа и имени. Порт _renderCamList. */

export function CameraList() {
    useConfStore();

    return (
        <div className="conf-item-list">
            {confState.cameras.map(cam => {
                const isSelected = confState.selected?.id === cam.id;
                return (
                    <div key={cam.id} className="conf-item-wrap">
                        <div
                            className={`conf-item ${isSelected ? 'selected' : ''}`}
                            onClick={() => confSelect({ type: 'camera', id: cam.id })}
                        >
                            <div className="conf-item-color" style={{ background: cam.color }} />
                            <span className="conf-item-name">{cam.name}</span>
                            <span className="conf-item-meta">{cam.w}×{cam.h}</span>
                            <button
                                className="conf-item-delete"
                                onClick={e => {
                                    e.stopPropagation();
                                    confDelete('camera', cam.id);
                                }}
                            >
                                ✕
                            </button>
                        </div>

                        {isSelected && (
                            <div className="conf-item-edit">
                                <div className="field-row">
                                    <div className="field-group">
                                        <label className="field-label">Ключ</label>
                                        <input
                                            className="field-input"
                                            type="text"
                                            value={cam.key}
                                            onChange={e => confRenameCamera(cam.id, { key: e.target.value })}
                                            onBlur={e => confRenameCamera(cam.id, { key: e.target.value.trim() })}
                                        />
                                    </div>
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
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
