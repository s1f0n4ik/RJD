import { useRef } from 'react';
import { confState, useConfStore } from '../../state/conf-store';
import { useToast } from '../common/Toast';
import { NumberField } from '../common/NumberField';
import {
    confAddCamera,
    confAddImageFile,
    confAddZone,
    confToggleFixedZone,
    confUpdateField,
    confUpdateFixedZone,
} from './conf-actions';
import { CameraList } from './CameraList';
import { ZoneList } from './ZoneList';
import { ImageList } from './ImageList';

/** Выдвижная панель конфигуратора. Порт panel.js и разметки page-4. */

interface ConfiguratorPanelProps {
    open: boolean;
    onOpenExport: () => void;
}

export function ConfiguratorPanel({ open, onOpenExport }: ConfiguratorPanelProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const showToast = useToast();

    useConfStore();

    const f = confState.field;
    const fixed = confState.fixedZoneSize;

    const handleAddZone = () => {
        const err = confAddZone();
        if (err) showToast('Нет камер', err, 'err');
    };

    return (
        <div className={`conf-panel ${open ? 'open' : ''}`}>
            <div className="conf-panel-inner">

                <details className="conf-section" open>
                    <summary className="conf-section-header">
                        <span>Поле</span>
                        <span className="collapsible-arrow">›</span>
                    </summary>
                    <div className="conf-section-body">
                        <div className="field-row">
                            <NumberField
                                label="Ширина"
                                min={1}
                                value={f.w}
                                onCommit={v => confUpdateField({ w: v || 1000 })}
                            />
                            <NumberField
                                label="Высота"
                                min={1}
                                value={f.h}
                                onCommit={v => confUpdateField({ h: v || 1000 })}
                            />
                        </div>
                        <NumberField
                            label="Шаг привязки"
                            min={1}
                            value={f.step}
                            onCommit={v => confUpdateField({ step: v || 10 })}
                        />
                    </div>
                </details>

                <details className="conf-section">
                    <summary className="conf-section-header">
                        <span>Камеры</span>
                        <span className="conf-section-count">{confState.cameras.length}</span>
                        <span className="collapsible-arrow">›</span>
                    </summary>
                    <div className="conf-section-body">
                        <CameraList />
                        <button
                            className="btn btn-ghost btn-sm"
                            style={{ width: '100%' }}
                            onClick={confAddCamera}
                        >
                            + Добавить камеру
                        </button>
                    </div>
                </details>

                <details className="conf-section">
                    <summary className="conf-section-header">
                        <span>Разметка</span>
                        <span className="conf-section-count">{confState.zones.length}</span>
                        <span className="collapsible-arrow">›</span>
                    </summary>
                    <div className="conf-section-body">
                        <label className="toggle-row" style={{ padding: '4px 0' }}>
                            <span className="toggle-label">Фикс. размер</span>
                            <input
                                className="toggle-input"
                                type="checkbox"
                                checked={fixed.enabled}
                                onChange={e => confToggleFixedZone(e.target.checked)}
                            />
                            <span className="toggle-track"><span className="toggle-thumb" /></span>
                        </label>

                        {fixed.enabled && (
                            <div className="conf-fixed-zone-fields">
                                <div className="field-row">
                                    <NumberField
                                        label="Ширина"
                                        min={1}
                                        value={fixed.w}
                                        onCommit={v => confUpdateFixedZone({ w: v || 100 })}
                                    />
                                    <NumberField
                                        label="Высота"
                                        min={1}
                                        value={fixed.h}
                                        onCommit={v => confUpdateFixedZone({ h: v || 100 })}
                                    />
                                </div>
                            </div>
                        )}

                        <ZoneList />
                        <button
                            className="btn btn-ghost btn-sm"
                            style={{ width: '100%' }}
                            onClick={handleAddZone}
                        >
                            + Добавить область
                        </button>
                    </div>
                </details>

                <details className="conf-section">
                    <summary className="conf-section-header">
                        <span>Рисунки</span>
                        <span className="conf-section-count">{confState.images.length}</span>
                        <span className="collapsible-arrow">›</span>
                    </summary>
                    <div className="conf-section-body">
                        <ImageList />
                        <button
                            className="btn btn-ghost btn-sm"
                            style={{ width: '100%' }}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            + Загрузить рисунок
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            style={{ display: 'none' }}
                            onChange={e => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (file) confAddImageFile(file);
                            }}
                        />
                    </div>
                </details>

                <button className="btn conf-export-btn" onClick={onOpenExport}>
                    Рассчитать конфигурацию
                </button>

            </div>
        </div>
    );
}
