import { useState } from 'react';
import { confState } from '../../state/conf-store';
import { useToast } from '../common/Toast';
import { buildExportJson, formatExportJson, saveExport } from './conf-export';

/** Модалка экспорта конфигурации. Порт confExportModal и export.js. */

interface ExportModalProps {
    onClose: () => void;
}

export function ExportModal({ onClose }: ExportModalProps) {
    // Предзаполнение загруженным пресетом: сохранение перезапишет его
    const [id, setId] = useState(confState.presetId);
    const [name, setName] = useState(confState.presetName);
    const [scaleInput, setScaleInput] = useState('1');
    const [saving, setSaving] = useState(false);
    const showToast = useToast();

    const scale = Math.max(0.1, +scaleInput || 1);
    const f = confState.field;
    const preview = formatExportJson(buildExportJson({ id, name, scale }));

    const handleSave = async () => {
        if (!id.trim()) {
            showToast('ID не указан', 'Заполните поле ID конфигурации', 'err');
            return;
        }

        setSaving(true);
        try {
            const result = await saveExport({ id: id.trim(), name: name.trim(), scale });
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
        <div className="modal-backdrop" onClick={onClose}>
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

                    <div className="field-row">
                        <div className="field-group">
                            <label className="field-label">Масштаб (у.е. → px)</label>
                            <input
                                className="field-input"
                                type="number"
                                min={0.1}
                                step={0.1}
                                value={scaleInput}
                                onChange={e => setScaleInput(e.target.value)}
                            />
                        </div>
                        <div className="field-group">
                            <label className="field-label">Итоговый canvas</label>
                            <span className="modal-stat-value" style={{ paddingTop: 4 }}>
                                {Math.round(f.w * scale)} × {Math.round(f.h * scale)} px
                            </span>
                        </div>
                    </div>

                    <div className="conf-export-preview-wrap">
                        <pre className="conf-export-preview">{preview}</pre>
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                        ⊛ {saving ? 'Сохранение...' : 'Сохранить'}
                    </button>
                </div>
            </div>
        </div>
    );
}
