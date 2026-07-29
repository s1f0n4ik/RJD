import { useState } from 'react';
import { useBackdropClose } from '../../hooks/useBackdropClose';
import { confState, useConfStore } from '../../state/conf-store';
import { useToast } from '../common/Toast';
import { buildExportJson, formatExportJson, saveExport } from './conf-export';
import { checkCameraKeys } from './conf-validate';

// Модалка экспорта конфигурации.

interface ExportModalProps {
    onClose: () => void;
}

export function ExportModal({ onClose }: ExportModalProps) {
    const backdrop = useBackdropClose(onClose);
    // Предзаполнение загруженным пресетом: сохранение перезапишет его
    const [id, setId] = useState(confState.presetId);
    const [name, setName] = useState(confState.presetName);
    const [saving, setSaving] = useState(false);
    const showToast = useToast();

    useConfStore();

    const keys = checkCameraKeys();
    const preview = formatExportJson(buildExportJson({ id, name }));

    const handleSave = async () => {
        // Дубль ключа схлопнул бы две камеры в одну запись экспорта
        if (keys.blocked) return;

        if (!id.trim()) {
            showToast('ID не указан', 'Заполните поле ID конфигурации', 'err');
            return;
        }

        setSaving(true);
        try {
            const result = await saveExport({ id: id.trim(), name: name.trim() });
            // Следующее сохранение перезапишет уже эту запись
            confState.presetId = id.trim();
            confState.presetName = name.trim();
            onClose();
            showToast('Конфигурация сохранена', `${id.trim()} · ${result.name}`, 'ok');
        } catch (err) {
            showToast('Ошибка сохранения', err instanceof Error ? err.message : String(err), 'err');
            console.error('saveExport:', err);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal-window modal-window--wide" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Экспорт конфигурации</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-body" style={{ gap: 14 }}>
                    <div className="field-row">
                        <div className="field-group">
                            <label className="field-label">ID конфигурации</label>
                            <input
                                className="field-input"
                                type="text"
                                placeholder="my_config_360"
                                value={id}
                                onChange={e => setId(e.target.value)}
                            />
                        </div>
                        <div className="field-group">
                            <label className="field-label">Название</label>
                            <input
                                className="field-input"
                                type="text"
                                placeholder="Мой birdview"
                                value={name}
                                onChange={e => setName(e.target.value)}
                            />
                        </div>
                    </div>

                    {keys.problems.length > 0 && (
                        <div className="conf-problems">
                            {keys.problems.map((p, i) => (
                                <span key={i} className={`conf-problem conf-problem--${p.status}`}>
                                    {p.status === 'error' ? '✕' : '⚠'} {p.text}
                                </span>
                            ))}
                        </div>
                    )}

                    <div className="conf-export-preview-wrap">
                        <pre className="conf-export-preview">{preview}</pre>
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button
                        className="btn btn-primary"
                        onClick={handleSave}
                        disabled={saving || keys.blocked}
                    >
                        ⊛ {saving ? 'Сохранение...' : 'Сохранить'}
                    </button>
                </div>
            </div>
        </div>
    );
}
