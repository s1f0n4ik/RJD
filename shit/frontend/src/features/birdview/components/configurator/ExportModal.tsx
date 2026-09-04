import { useState } from 'react';
import { Modal } from '../../../../app/Modal';
import { confState, useConfStore } from '../../state/conf-store';
import { useToast } from '../common/Toast';
import { buildExportJson, formatExportJson, saveExport } from './conf-export';
import { checkCameraKeys } from './conf-validate';

// Модалка расчёта конфигурации: JSON слева, замечания справа

interface ExportModalProps {
    onClose: () => void;
}

export function ExportModal({ onClose }: ExportModalProps) {
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
        <Modal
            title="Расчёт конфигурации"
            size="mid"
            onClose={onClose}
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                    <button
                        className="btn btn--acc"
                        onClick={handleSave}
                        disabled={saving || keys.blocked || !id.trim()}
                    >
                        {saving && <span className="spin sm" />}
                        {saving ? 'Сохранение…' : 'Сохранить'}
                    </button>
                </>
            }
        >
            <div className="modal-b conf-export">
                <div className="tf-row">
                    <div className="tf">
                        <span className="tf-cap">ID конфигурации</span>
                        <input
                            className={`tf-in${id.trim() ? '' : ' is-err'}`}
                            type="text"
                            placeholder="my_config_360"
                            value={id}
                            onChange={e => setId(e.target.value)}
                        />
                    </div>
                    <div className="tf">
                        <span className="tf-cap">Название</span>
                        <input
                            className="tf-in"
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                        />
                    </div>
                </div>

                <pre className="conf-json">{preview}</pre>

                <div className="conf-problems">
                    {keys.problems.length === 0 ? (
                        <div className="kv">
                            <span className="k"><span className="tag is-ok">без замечаний</span></span>
                        </div>
                    ) : (
                        keys.problems.map((p, i) => (
                            <div key={i} className="kv">
                                <span className="k">
                                    <span className={`tag ${p.status === 'error' ? 'is-err' : 'is-warn'}`}>
                                        {p.status === 'error' ? 'ошибка' : 'внимание'}
                                    </span>
                                </span>
                                <span className="v">{p.text}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </Modal>
    );
}
