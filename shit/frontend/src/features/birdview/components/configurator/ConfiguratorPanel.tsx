import { useRef, useState } from 'react';
import { confState, q, useConfStore } from '../../state/conf-store';
import { useToast } from '../common/Toast';
import { NumberField } from '../common/NumberField';
import {
    confAddCamera,
    confAddGabarit,
    confAddImageFile,
    confCenterGabarit,
    confDropCamera,
    confDropZone,
    confSetPlacing,
    confUpdateGabarit,
    confUpdateGabaritPos,
    confUpdateMachineHeight,
    confUpdateMatSize,
    confUpdateField,
    confUpdatePxPerM,
} from './conf-actions';
import { canvasToWorld } from './conf-canvas';
import { canvasSizePx } from './conf-export';
import { CameraList } from './CameraList';
import { ZoneList } from './ZoneList';
import { ImageList } from './ImageList';

// Выдвижная панель конфигуратора. Все линейные поля — метры, шаг ввода 1 мм.

const M_STEP = 0.001;

// Смещение, после которого нажатие считается перетаскиванием
const DRAG_THRESHOLD = 4;

interface ConfiguratorPanelProps {
    open: boolean;
    onOpenExport: () => void;
    onOpenAddZone: () => void;
}

export function ConfiguratorPanel({ open, onOpenExport, onOpenAddZone }: ConfiguratorPanelProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
    const [dragging, setDragging] = useState(false);
    const showToast = useToast();

    useConfStore();

    const f = confState.field;
    const gab = confState.gabarits[0];
    const raster = canvasSizePx();

    const applyField = (next: Partial<{ w: number; h: number; step: number }>) => {
        const err = confUpdateField(next);
        if (err) showToast('Поле не изменено', err, 'err');
    };

    const applyMat = (value: number) => {
        const err = confUpdateMatSize(value);
        if (err) showToast('Размер мата не изменён', err, 'err');
    };

    // Кнопки создания работают на два жеста: потянули — объект встаёт углом в
    // точку отпускания, просто нажали — срабатывает onTap.
    // Указатель захватывается кнопкой, поэтому превью ведётся и над панелью
    const placeHandlers = (
        kind: 'zone' | 'camera',
        onTap: () => void,
        onDrop: (x: number, y: number) => void,
    ) => ({
        onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
        },

        onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
            const d = dragRef.current;
            if (!d) return;

            if (!d.moved) {
                const far = Math.abs(e.clientX - d.x) > DRAG_THRESHOLD
                    || Math.abs(e.clientY - d.y) > DRAG_THRESHOLD;
                if (!far) return;
                d.moved = true;
                setDragging(true);
            }

            confSetPlacing(kind, canvasToWorld(e.clientX, e.clientY));
        },

        onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
            const d = dragRef.current;
            dragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            if (!d) return;

            setDragging(false);
            confSetPlacing(kind, null);

            if (!d.moved) {
                onTap();
                return;
            }

            const p = canvasToWorld(e.clientX, e.clientY);
            onDrop(p.x, p.y);
        },
    });

    const zoneDrag = placeHandlers('zone', onOpenAddZone, (x, y) => {
        const err = confDropZone(x, y);
        if (err) showToast('Мат не поставлен', err, 'err');
    });

    // Нажатие на кнопку камеры создаёт её по центру поля, как и раньше
    const cameraDrag = placeHandlers('camera', confAddCamera, confDropCamera);

    return (
        <div className={`conf-panel ${open ? 'open' : ''} ${dragging ? 'dragging' : ''}`}>
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
                        {/* Позиция задаётся центром: им же габарит ставится инструментом */}
                        <div className="field-row">
                            <NumberField
                                label="Центр X, м"
                                min={0}
                                step={M_STEP}
                                value={gab ? q(gab.x + gab.w / 2) : 0}
                                onCommit={v => confUpdateGabaritPos({ cx: v })}
                            />
                            <NumberField
                                label="Центр Y, м"
                                min={0}
                                step={M_STEP}
                                value={gab ? q(gab.y + gab.h / 2) : 0}
                                onCommit={v => confUpdateGabaritPos({ cy: v })}
                            />
                        </div>
                        <button
                            className="btn btn-ghost btn-sm"
                            style={{ width: '100%' }}
                            onClick={confCenterGabarit}
                        >
                            Оцентровать
                        </button>
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
                            className="btn btn-ghost btn-sm conf-place-btn"
                            style={{ width: '100%' }}
                            title="Потяните на холст или нажмите, чтобы создать по центру поля"
                            {...cameraDrag}
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
                            className="btn btn-ghost btn-sm conf-place-btn"
                            style={{ width: '100%' }}
                            title="Потяните на холст или нажмите, чтобы задать угол числами"
                            {...zoneDrag}
                        >
                            + Добавить разметку
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
