import { useEffect, useState } from 'react';
import { Modal } from '../../../../app/Modal';
import { projState } from '../../state/proj-store';
import { linkerApi } from '../../api/linker';
import type { LinkerExport } from '../../api/linker';

// Модалка расчёта LUT: идентификатор, название, перезапись существующего экспорта

// Набор символов серверной проверки id
const LUT_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Идентификатор по имени пресета плюс короткий суффикс времени
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

    // Существующие конфигурации: клик подставляет id и имя для перезаписи
    const [exports, setExports] = useState<LinkerExport[]>([]);
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

    const trimmedId = id.trim();
    const idValid = LUT_ID_RE.test(trimmedId);
    const nameValid = name.trim().length > 0;
    const overwrite = exports.some(e => e.id === trimmedId);

    const cams = projState.activePreset?.cameras ?? [];
    const done = cams.filter(c => projState.doneSet.has(c.key)).length;

    return (
        <Modal
            title="Рассчитать LUT"
            onClose={onClose}
            className="modal--lut"
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                    <button
                        className="btn btn--save"
                        disabled={!idValid || !nameValid || saving}
                        onClick={() => onSubmit(trimmedId, name.trim())}
                    >
                        {saving ? 'Сохранение…' : overwrite ? 'Перезаписать' : 'Сохранить LUT'}
                    </button>
                </>
            }
        >
            <div className="modal-b">
                <div className="tf-row">
                    <label className="tf">
                        <span className="tf-cap">Идентификатор</span>
                        <input
                            className={`tf-in${idValid ? '' : ' is-err'}`}
                            type="text"
                            autoFocus
                            value={id}
                            onChange={e => setId(e.target.value)}
                        />
                    </label>
                    <label className="tf">
                        <span className="tf-cap">Название</span>
                        <input
                            className="tf-in"
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                        />
                    </label>
                </div>

                {exports.length > 0 && (
                    <div>
                        <div className="sub-h">Перезаписать существующую</div>
                        <div className="cfg-rows">
                            {exports.map(e => {
                                const live = e.id === liveExportId;
                                return (
                                    <button
                                        key={e.id}
                                        className={`cfg-row${e.id === trimmedId ? ' is-sel' : ''}`}
                                        onClick={() => {
                                            setId(e.id);
                                            setName(e.name ?? e.id);
                                        }}
                                    >
                                        <span className={`dot${live ? ' ok' : ''}`} />
                                        <div className="t">
                                            <b>{e.name || e.id}</b>
                                            <span>{e.id}</span>
                                        </div>
                                        {live && <span className="tag is-ok">в эфире</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div className="kv">
                    <span className="k">Мест с warp</span>
                    <span className="v num">{done} из {cams.length}</span>
                </div>
            </div>
        </Modal>
    );
}
