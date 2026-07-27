import { useEffect, useRef, useState } from 'react';
import { projState } from '../../state/proj-store';
import { linkerApi } from '../../api/linker';
import type { LinkerExport } from '../../api/linker';
import { useBackdropClose } from '../../hooks/useBackdropClose';

/** Модалка сохранения LUT. Порт lut-modal.js. */

// Набор символов серверной проверки id: иначе существующую конфигурацию
// с дефисом или заглавной нельзя было бы перезаписать
const LUT_ID_RE = /^[a-zA-Z0-9_-]+$/;

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
    const backdrop = useBackdropClose(onClose);
    const [id, setId] = useState(generateId);
    const [name, setName] = useState('');

    // Существующие конфигурации: выбор подставляет id и имя для перезаписи
    const [exports, setExports] = useState<LinkerExport[]>([]);
    const [listOpen, setListOpen] = useState(false);
    const idWrapRef = useRef<HTMLDivElement>(null);
    // Конфигурация в эфире: её перезапись требует ручного перезапуска вывода
    const [liveExportId, setLiveExportId] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        linkerApi.getExports()
            .then(list => {
                if (alive) setExports(list);
            })
            .catch(() => {});
        linkerApi.getStatus()
            .then(st => {
                if (alive && st.running) setLiveExportId(st.exportId);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        if (!listOpen) return;
        const onClickOutside = (e: MouseEvent) => {
            if (idWrapRef.current && !idWrapRef.current.contains(e.target as Node)) {
                setListOpen(false);
            }
        };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, [listOpen]);

    const trimmedId = id.trim();
    const idValid = LUT_ID_RE.test(trimmedId);
    const nameValid = name.trim().length > 0;
    // Совпадение с существующим id — осознанная перезапись, кнопка честно говорит об этом
    const overwrite = exports.some(e => e.id === trimmedId);

    const liveOverwrite = overwrite && trimmedId === liveExportId;

    const hint = !trimmedId
        ? 'ID не может быть пустым'
        : !idValid
          ? 'Только латиница, цифры, _ и -'
          : liveOverwrite
            ? 'Конфигурация сейчас в эфире — после сохранения перезапустите вывод в линкере'
            : overwrite
              ? 'Существующая конфигурация будет перезаписана'
              : 'Только латиница, цифры, _ и -';

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal-window" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Сохранение конфигурации</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-body">
                    <div className="field-group">
                        <label className="field-label">ID конфигурации</label>
                        <div
                            ref={idWrapRef}
                            className={`custom-select lut-id${listOpen ? ' open' : ''}`}
                        >
                            <input
                                className={`field-input lut-id-input${idValid ? '' : ' invalid'}`}
                                type="text"
                                autoFocus
                                value={id}
                                onChange={e => setId(e.target.value)}
                            />
                            <button
                                type="button"
                                className="lut-id-arrow"
                                title="Перезаписать существующую конфигурацию"
                                onClick={() => setListOpen(o => !o)}
                            >
                                <span className="custom-select-arrow">›</span>
                            </button>
                            {listOpen && (
                                <div className="custom-select-dropdown">
                                    {exports.length === 0 ? (
                                        <div className="custom-select-empty">
                                            Сохранённых конфигураций нет
                                        </div>
                                    ) : (
                                        <div className="custom-select-list">
                                            {exports.map(e => (
                                                <div
                                                    key={e.id}
                                                    className={
                                                        'custom-select-item' +
                                                        (e.id === trimmedId ? ' selected' : '')
                                                    }
                                                    onClick={() => {
                                                        setId(e.id);
                                                        setName(e.name ?? e.id);
                                                        setListOpen(false);
                                                    }}
                                                >
                                                    <span className="custom-select-item-name">
                                                        {e.name || e.id}
                                                    </span>
                                                    <span className="custom-select-item-note">
                                                        {e.id}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
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
                        {saving ? 'Сохранение...' : overwrite ? 'Перезаписать' : 'Сохранить'}
                    </button>
                </div>
            </div>
        </div>
    );
}
