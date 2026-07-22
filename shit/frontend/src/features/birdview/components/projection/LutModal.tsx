import { useState } from 'react';
import { projState } from '../../state/proj-store';

/** Модалка сохранения LUT. Порт lut-modal.js. */

const LUT_ID_RE = /^[a-z][a-z0-9_]*$/;

/** Идентификатор по имени пресета плюс короткий суффикс времени. */
function generateId(): string {
    const presetName = projState.activePreset?.name ?? 'config';
    const base =
        presetName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .replace(/^[0-9]+/, '') || 'config';

    return `${base}_${Date.now().toString(36).slice(-5)}`;
}

interface LutModalProps {
    saving: boolean;
    onSubmit: (id: string, name: string) => void;
    onClose: () => void;
}

export function LutModal({ saving, onSubmit, onClose }: LutModalProps) {
    const [id, setId] = useState(generateId);
    const [name, setName] = useState('');

    const trimmedId = id.trim();
    const idValid = LUT_ID_RE.test(trimmedId);
    const nameValid = name.trim().length > 0;

    const hint = !trimmedId
        ? 'ID не может быть пустым'
        : !idValid
          ? 'Только латиница, цифры и _, начинается с буквы'
          : 'Только латиница, цифры и _';

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-window" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Сохранение конфигурации</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-body">
                    <div className="field-group">
                        <label className="field-label">ID конфигурации</label>
                        <input
                            className={`field-input${idValid ? '' : ' invalid'}`}
                            type="text"
                            autoFocus
                            value={id}
                            onChange={e => setId(e.target.value)}
                        />
                        <span className={`modal-hint${idValid ? '' : ' err'}`}>{hint}</span>
                    </div>

                    <div className="field-group">
                        <label className="field-label">Название</label>
                        <input
                            className="field-input"
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                        />
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button
                        className="btn btn-primary"
                        disabled={!idValid || !nameValid || saving}
                        onClick={() => onSubmit(trimmedId, name.trim())}
                    >
                        {saving ? 'Сохранение...' : 'Сохранить'}
                    </button>
                </div>
            </div>
        </div>
    );
}
