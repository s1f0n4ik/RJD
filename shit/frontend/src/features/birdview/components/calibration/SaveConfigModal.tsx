import { useState } from 'react';
import { Modal } from '../../../../app/Modal';
import type { ConfigSummary } from './ConfigModal';
import type { PatternInfo } from './CalibrationBlock';

// Сохранение конфигурации калибровки под ключом оператора

const KEY_RE = /^[A-Za-z0-9_-]+$/;

interface SaveConfigModalProps {
    // Уже сохранённые конфигурации: по ним подставляется свободный ключ
    existing: ConfigSummary[];
    cameraId: string;
    cameraName: string;
    width: number;
    height: number;
    pattern: PatternInfo | null;
    rms: number | null;
    saving: boolean;
    onSubmit: (key: string, name: string) => void;
    onClose: () => void;
}

// Ключ из камеры и разрешения плюс порядковый номер, если занят
function suggestKey(cameraId: string, width: number, height: number, taken: Set<string>): string {
    const base = `${cameraId}_${width}_${height}`;
    if (!taken.has(base)) return base;

    for (let n = 2; n < 1000; n++) {
        const candidate = `${base}_${n}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${base}_${Date.now().toString(36).slice(-4)}`;
}

export function SaveConfigModal({
    existing,
    cameraId,
    cameraName,
    width,
    height,
    pattern,
    rms,
    saving,
    onSubmit,
    onClose,
}: SaveConfigModalProps) {
    const taken = new Set(existing.map(c => c.config_key ?? c.id));

    const [key, setKey] = useState(() => suggestKey(cameraId, width, height, taken));
    const [confirmOverwrite, setConfirmOverwrite] = useState(false);

    const trimmedKey = key.trim();
    const keyValid = KEY_RE.test(trimmedKey);
    const collides = keyValid && taken.has(trimmedKey);

    const submit = () => {
        if (!keyValid) return;
        // Подставленный ключ свободен, совпадение означает ввод руками
        if (collides && !confirmOverwrite) {
            setConfirmOverwrite(true);
            return;
        }
        onSubmit(trimmedKey, '');
    };

    return (
        <Modal
            title="Сохранить конфигурацию"
            onClose={onClose}
            className="modal--cfg-save"
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>
                        Отмена
                    </button>
                    <button
                        className={`btn ${confirmOverwrite ? 'btn--err' : 'btn--save'}`}
                        disabled={!keyValid || saving}
                        onClick={submit}
                    >
                        {saving ? 'Сохранение…' : confirmOverwrite ? 'Перезаписать' : 'Сохранить'}
                    </button>
                </>
            }
        >
            <div className="modal-b">
                <div className="tf">
                    <span className="tf-cap">Ключ</span>
                    <input
                        className={`tf-in${!keyValid ? ' is-err' : collides ? ' is-warn' : ''}`}
                        type="text"
                        autoFocus
                        value={key}
                        onChange={e => {
                            setKey(e.target.value);
                            setConfirmOverwrite(false);
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') submit();
                        }}
                    />
                </div>
                <div>
                    <div className="kv">
                        <span className="k">Камера</span>
                        <span className="v">{cameraName}</span>
                    </div>
                    <div className="kv">
                        <span className="k">Разрешение</span>
                        <span className="v num">{`${width}×${height}`}</span>
                    </div>
                    <div className="kv">
                        <span className="k">Шаблон</span>
                        <span className="v num">
                            {pattern ? `${pattern.width}×${pattern.height} · ${pattern.size} мм` : '—'}
                        </span>
                    </div>
                    <div className="kv">
                        <span className="k">RMS</span>
                        <span className="v num" style={rms !== null ? { color: 'var(--ok)' } : undefined}>
                            {rms !== null ? `${rms.toFixed(2).replace('.', ',')} px` : '—'}
                        </span>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
