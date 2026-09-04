import { useState } from 'react';
import { Modal } from '../../../../app/Modal';
import { confState, fmtM, q } from '../../state/conf-store';
import { NumberField } from '../common/NumberField';
import { useToast } from '../common/Toast';
import { zoneFitsField } from './conf-canvas';
import { confPlaceZone } from './conf-actions';

// Добавление мата числами. Точка — верхний левый угол мата; камеры захватывают
// мат сами, когда накрывают его целиком

const M_STEP = 0.001;

interface AddZoneModalProps {
    onClose: () => void;
}

export function AddZoneModal({ onClose }: AddZoneModalProps) {
    const showToast = useToast();

    const f = confState.field;
    const mat = confState.matSize;

    const [corner, setCorner] = useState({
        x: q((f.w - mat) / 2),
        y: q((f.h - mat) / 2),
    });

    const range = { x1: q(f.w - mat), y1: q(f.h - mat) };

    const fits = zoneFitsField(mat);
    const xBad = !fits || corner.x < 0 || corner.x > range.x1;
    const yBad = !fits || corner.y < 0 || corner.y > range.y1;

    const problem = !fits
        ? `Мат ${fmtM(mat)} м не помещается в поле ${fmtM(f.w)}×${fmtM(f.h)} м`
        : xBad || yBad
            ? `Допустимо X 0…${fmtM(range.x1)}, Y 0…${fmtM(range.y1)}`
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
        <Modal
            title="Добавление разметки"
            onClose={onClose}
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                    <button className="btn btn--acc" onClick={handleAdd} disabled={problem !== null}>
                        Добавить
                    </button>
                </>
            }
        >
            <div className="modal-b conf-modal-b">
                <div className="tf-row" title={problem ?? undefined}>
                    <NumberField
                        label="Угол X"
                        unit="м"
                        min={0}
                        step={M_STEP}
                        value={corner.x}
                        className={xBad ? 'is-err' : undefined}
                        onCommit={v => setCorner(c => ({ ...c, x: q(v) }))}
                    />
                    <NumberField
                        label="Угол Y"
                        unit="м"
                        min={0}
                        step={M_STEP}
                        value={corner.y}
                        className={yBad ? 'is-err' : undefined}
                        onCommit={v => setCorner(c => ({ ...c, y: q(v) }))}
                    />
                </div>

                <div>
                    <div className="kv"><span className="k">Сторона мата</span><span className="v">{fmtM(mat)} м</span></div>
                    <div className="kv"><span className="k">Поле</span><span className="v">{fmtM(f.w)} × {fmtM(f.h)} м</span></div>
                </div>
            </div>
        </Modal>
    );
}
