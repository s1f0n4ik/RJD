import { useState } from 'react';
import type { ConfigSummary } from './ConfigModal';

/**
 * Сохранение конфигурации калибровки под своим ключом и именем.
 *
 * Ключ раньше собирался сервером из id камеры и разрешения, поэтому на камеру
 * приходилась ровно одна конфигурация. Теперь его задаёт оператор — под разный
 * обзор одной и той же камеры нужны разные наборы коррекции.
 */

const KEY_RE = /^[A-Za-z0-9_-]+$/;

interface SaveConfigModalProps {
    /** Уже сохранённые конфигурации: по ним подставляется свободный ключ. */
    existing: ConfigSummary[];
    cameraId: string;
    width: number;
    height: number;
    saving: boolean;
    onSubmit: (key: string, name: string) => void;
    onClose: () => void;
}

/**
 * Прежнее правило ключа плюс порядковый номер, если такой уже занят.
 * Оператор чаще всего просто жмёт «Сохранить», и уронить чужую запись
 * подставленным значением недопустимо.
 */
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
    width,
    height,
    saving,
    onSubmit,
    onClose,
}: SaveConfigModalProps) {
    const taken = new Set(existing.map(c => c.config_key ?? c.id));

    const [key, setKey] = useState(() => suggestKey(cameraId, width, height, taken));
    const [name, setName] = useState('');
    const [confirmOverwrite, setConfirmOverwrite] = useState(false);

    const trimmedKey = key.trim();
    const keyValid = KEY_RE.test(trimmedKey);
    const collides = keyValid && taken.has(trimmedKey);

    const hint = !trimmedKey
        ? 'Идентификатор не может быть пустым'
        : !keyValid
          ? 'Только латиница, цифры, дефис и подчёркивание'
          : collides
            ? 'Такая конфигурация уже есть'
            : 'Только латиница, цифры, дефис и подчёркивание';

    const submit = () => {
        if (!keyValid) return;
        // Совпадение подставленного ключа исключено, значит его ввели руками
        if (collides && !confirmOverwrite) {
            setConfirmOverwrite(true);
            return;
        }
        onSubmit(trimmedKey, name.trim());
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-window" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Сохранение конфигурации</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-body">
                    <div className="field-group">
                        <label className="field-label">Идентификатор</label>
                        <input
                            className={`field-input${keyValid ? '' : ' invalid'}`}
                            type="text"
                            autoFocus
                            value={key}
                            onChange={e => {
                                setKey(e.target.value);
                                setConfirmOverwrite(false);
                            }}
                        />
                        <span className={`modal-hint${keyValid && !collides ? '' : ' err'}`}>{hint}</span>
                    </div>

                    <div className="field-group">
                        <label className="field-label">Название</label>
                        <input
                            className="field-input"
                            type="text"
                            placeholder="Например: широкий обзор"
                            value={name}
                            onChange={e => setName(e.target.value)}
                        />
                        <span className="modal-hint">Показывается в списке конфигураций</span>
                    </div>

                    <p className="modal-text">
                        Камера {cameraId} · {width}×{height}
                    </p>

                    {confirmOverwrite && (
                        <p className="modal-text modal-text--warn">
                            Конфигурация «{trimmedKey}» уже существует. Повторное нажатие
                            перезапишет её вместе с картами коррекции.
                        </p>
                    )}
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button
                        className={`btn ${confirmOverwrite ? 'btn-danger' : 'btn-primary'}`}
                        disabled={!keyValid || saving}
                        onClick={submit}
                    >
                        {saving ? 'Сохранение...' : confirmOverwrite ? 'Перезаписать' : 'Сохранить'}
                    </button>
                </div>
            </div>
        </div>
    );
}
