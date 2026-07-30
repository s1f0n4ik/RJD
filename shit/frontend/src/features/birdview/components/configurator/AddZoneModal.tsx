import { useState } from 'react';
import { useBackdropClose } from '../../hooks/useBackdropClose';
import { confState, fmtM, q } from '../../state/conf-store';
import { NumberField } from '../common/NumberField';
import { useToast } from '../common/Toast';
import { zoneFitsField } from './conf-canvas';
import { confPlaceZone } from './conf-actions';

// Добавление разметки числами. Точка — верхний левый угол мата, как и в подписи
// выделения. Камеры к постановке не причастны: они захватывают мат сами,
// когда накрывают его целиком.

const M_STEP = 0.001;

interface AddZoneModalProps {
    onClose: () => void;
}

export function AddZoneModal({ onClose }: AddZoneModalProps) {
    const backdrop = useBackdropClose(onClose);
    const showToast = useToast();

    const f = confState.field;
    const mat = confState.matSize;

    const [corner, setCorner] = useState({
        x: q((f.w - mat) / 2),
        y: q((f.h - mat) / 2),
    });

    const range = { x1: q(f.w - mat), y1: q(f.h - mat) };

    const problem = !zoneFitsField(mat, 0)
        ? `Мат ${fmtM(mat)} м не помещается в поле ${fmtM(f.w)}×${fmtM(f.h)} м`
        : corner.x < 0 || corner.x > range.x1 || corner.y < 0 || corner.y > range.y1
            ? `Угол вне поля. Допустимо X 0…${fmtM(range.x1)}, Y 0…${fmtM(range.y1)}`
            : null;

    const handleAdd = () => {
        if (problem) return;
        const err = confPlaceZone(corner.x, corner.y);
        if (err) {
            showToast('Мат не поставлен', err, 'err');
            return;
        }
        onClose();
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal-window" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Добавление разметки</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-body" style={{ gap: 14 }}>
                    <div className="field-row">
                        <NumberField
                            label="Угол X, м"
                            min={0}
                            step={M_STEP}
                            value={corner.x}
                            onCommit={v => setCorner(c => ({ ...c, x: q(v) }))}
                        />
                        <NumberField
                            label="Угол Y, м"
                            min={0}
                            step={M_STEP}
                            value={corner.y}
                            onCommit={v => setCorner(c => ({ ...c, y: q(v) }))}
                        />
                    </div>

                    <div className="field-group">
                        <label className="field-label">Сторона мата</label>
                        <span className="modal-stat-value">{fmtM(mat)} м</span>
                    </div>

                    {problem && (
                        <div className="conf-problems">
                            <span className="conf-problem conf-problem--error">✕ {problem}</span>
                        </div>
                    )}
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button className="btn btn-primary" onClick={handleAdd} disabled={problem !== null}>
                        Добавить
                    </button>
                </div>
            </div>
        </div>
    );
}
