import { Icon } from '../../../../app/Icons';
import { confState, useConfStore } from '../../state/conf-store';
import { confDelete, confRenameCamera, confSelect } from './conf-actions';
import { checkCameraKeys } from './conf-validate';

// Список камер с инлайновой правкой ключа и имени у выделенной строки

export function CameraList() {
    useConfStore();

    const keys = checkCameraKeys();

    return (
        <>
            {confState.cameras.map(cam => {
                const isSelected = confState.selected?.id === cam.id;
                const status = keys.status.get(cam.id) ?? 'ok';
                const keyClass = status === 'error' ? ' is-err' : status === 'warn' ? ' is-warn' : '';
                return (
                    <div key={cam.id}>
                        <div
                            className={`zrow${isSelected ? ' is-sel' : ''}`}
                            onClick={() => confSelect({ type: 'camera', id: cam.id })}
                        >
                            <span className={`cam-icon${status === 'error' ? ' err' : ''}`}>
                                <Icon name="cam" size={12} className="" />
                            </span>
                            <span className="nm">{cam.name}</span>
                            <span className={`key${keyClass}`}>{cam.key}</span>
                            <button
                                className="icon-btn x"
                                onClick={e => {
                                    e.stopPropagation();
                                    confDelete('camera', cam.id);
                                }}
                            >
                                <Icon name="x" size={12} className="" />
                            </button>
                        </div>

                        {isSelected && (
                            <div className="zrow-edit">
                                <div className="tf-row">
                                    {/* Ключ — place_key: по нему линкер держит привязку и переносит src_points */}
                                    <div className="tf">
                                        <span className="tf-cap">Ключ</span>
                                        <input
                                            className={`tf-in${keyClass}`}
                                            type="text"
                                            value={cam.key}
                                            onChange={e => confRenameCamera(cam.id, { key: e.target.value })}
                                            onBlur={e => confRenameCamera(cam.id, { key: e.target.value.trim() })}
                                        />
                                    </div>
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
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );
}
