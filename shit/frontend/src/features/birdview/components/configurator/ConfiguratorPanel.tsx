import { useRef } from 'react';
import { confState, useConfStore } from '../../state/conf-store';
import { useToast } from '../common/Toast';
import { NumberField } from '../common/NumberField';
import {
    confAddCamera,
    confAddGabarit,
    confAddImageFile,
    confAddZone,
    confUpdateGabarit,
    confUpdateMachineHeight,
    confUpdateMatSize,
    confUpdateField,
    confUpdatePxPerM,
} from './conf-actions';
import { canvasSizePx } from './conf-export';
import { CameraList } from './CameraList';
import { ZoneList } from './ZoneList';
import { ImageList } from './ImageList';

// Выдвижная панель конфигуратора. Все линейные поля — метры, шаг ввода 1 мм.

const M_STEP = 0.001;

interface ConfiguratorPanelProps {
    open: boolean;
    onOpenExport: () => void;
}

export function ConfiguratorPanel({ open, onOpenExport }: ConfiguratorPanelProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const showToast = useToast();

    useConfStore();

    const f = confState.field;
    const gab = confState.gabarits[0];
    const raster = canvasSizePx();

    const applyField = (next: Partial<{ w: number; h: number; step: number }>) => {
        const err = confUpdateField(next);
        if (err) showToast('Поле не изменено', err, 'err');
    };

    const handleAddZone = () => {
        const err = confAddZone();
        if (err) showToast('Мат не поставлен', err, 'err');
    };

    const applyMat = (value: number) => {
        const err = confUpdateMatSize(value);
        if (err) showToast('Размер мата не изменён', err, 'err');
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
                                label="Ширина, м"
                                min={M_STEP}
                                step={M_STEP}
                                value={f.w}
                                onCommit={v => applyField({ w: v })}
                            />
                            <NumberField
                                label="Длина, м"
                                min={M_STEP}
                                step={M_STEP}
                                value={f.h}
                                onCommit={v => applyField({ h: v })}
                            />
                        </div>
                        <NumberField
                            label="Шаг привязки, м"
                            min={M_STEP}
                            step={M_STEP}
                            value={f.step}
                            onCommit={v => applyField({ step: v })}
                        />
                        {/* Геометрию не двигает: задаёт только разрешение растра вида сверху */}
                        <NumberField
                            label="Разрешение, px/м"
                            min={1}
                            step={1}
                            value={confState.pxPerM}
                            onCommit={v => confUpdatePxPerM(v)}
                        />
                        <div className="field-group">
                            <label className="field-label">Итоговый растр</label>
                            <span className="modal-stat-value">
                                {raster.width} × {raster.height} px
                            </span>
                        </div>
                    </div>
                </details>

                <details className="conf-section">
                    <summary className="conf-section-header">
                        <span>Габарит</span>
                        <span className="conf-section-count">
                            {confState.gabarits.length ? '✓' : '—'}
                        </span>
                        <span className="collapsible-arrow">›</span>
                    </summary>
                    <div className="conf-section-body">
                        {/* Стороны прямоугольника и есть размеры машины */}
                        <button
                            className="btn btn-ghost btn-sm"
                            style={{ width: '100%' }}
                            onClick={confAddGabarit}
                        >
                            {confState.gabarits.length ? 'Выбрать габарит' : '+ Задать габарит'}
                        </button>
                        <div className="field-row">
                            <NumberField
                                label="Длина, м"
                                min={M_STEP}
                                step={M_STEP}
                                value={gab?.h ?? 0}
                                onCommit={v => confUpdateGabarit({ length: v })}
                            />
                            <NumberField
                                label="Ширина, м"
                                min={M_STEP}
                                step={M_STEP}
                                value={gab?.w ?? 0}
                                onCommit={v => confUpdateGabarit({ width: v })}
                            />
                        </div>
                        <NumberField
                            label="Высота, м"
                            min={0}
                            step={M_STEP}
                            value={confState.machineHeight}
                            onCommit={v => confUpdateMachineHeight(v)}
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
                        {/* Мат физический: сторона одна на все зоны и под камеру не ужимается */}
                        <NumberField
                            label="Сторона мата, м"
                            min={M_STEP}
                            step={M_STEP}
                            value={confState.matSize}
                            onCommit={applyMat}
                        />

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
