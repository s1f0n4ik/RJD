import { useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { confState, emitConfChange, q, useConfStore } from '../../state/conf-store';
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
import { canvasToWorld, zoneCameras } from './conf-canvas';
import { canvasSizePx } from './conf-export';
import { CameraList } from './CameraList';
import { ZoneList } from './ZoneList';
import { ImageList } from './ImageList';

// Правая панель конфигуратора. Все линейные поля — метры, шаг ввода 1 мм

const M_STEP = 0.001;

// Смещение, после которого нажатие считается перетаскиванием
const DRAG_THRESHOLD = 4;

interface ConfiguratorPanelProps {
    onOpenExport: () => void;
    onOpenAddZone: () => void;
}

export function ConfiguratorPanel({ onOpenExport, onOpenAddZone }: ConfiguratorPanelProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
    const [dragging, setDragging] = useState(false);
    const showToast = useToast();

    useConfStore();

    const f = confState.field;
    const gab = confState.gabarits[0];
    const raster = canvasSizePx();
    const outside = confState.zones.filter(z => zoneCameras(z).length === 0).length;

    const applyField = (next: Partial<{ w: number; h: number; step: number }>) => {
        const err = confUpdateField(next);
        if (err) showToast('Поле не изменено', err, 'err');
    };

    const applyMat = (value: number) => {
        const err = confUpdateMatSize(value);
        if (err) showToast('Размер мата не изменён', err, 'err');
    };

    // Кнопки создания работают на два жеста: потянули — объект встаёт в точку
    // отпускания, просто нажали — срабатывает onTap. Указатель захвачен кнопкой
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

    // Нажатие на кнопку камеры создаёт её по центру поля
    const cameraDrag = placeHandlers('camera', confAddCamera, confDropCamera);

    return (
        <aside className={`mod-side${dragging ? ' is-dragging' : ''}`}>
            <div className="blk-h">
                <h3>Поле</h3>
                <span className="eyebrow spacer">растр {raster.width}×{raster.height} px</span>
            </div>
            <div className="blk-b pad">
                <div className="tf-row">
                    <NumberField
                        label="Ширина"
                        unit="м"
                        min={M_STEP}
                        step={M_STEP}
                        value={f.w}
                        onCommit={v => applyField({ w: v })}
                    />
                    <NumberField
                        label="Длина"
                        unit="м"
                        min={M_STEP}
                        step={M_STEP}
                        value={f.h}
                        onCommit={v => applyField({ h: v })}
                    />
                </div>
                <div className="tf-row">
                    <NumberField
                        label="Шаг привязки"
                        unit="м"
                        min={M_STEP}
                        step={M_STEP}
                        value={f.step}
                        onCommit={v => applyField({ step: v })}
                    />
                    {/* Геометрию не двигает: задаёт только разрешение растра вида сверху */}
                    <NumberField
                        label="Разрешение"
                        unit="px/м"
                        min={1}
                        step={1}
                        value={confState.pxPerM}
                        onCommit={v => confUpdatePxPerM(v)}
                    />
                </div>
            </div>

            <div className="blk-h">
                <h3>Габарит</h3>
                <span className={`tag spacer${gab ? ' is-ok' : ''}`}>{gab ? 'задан' : 'не задан'}</span>
            </div>
            <div className="blk-b pad">
                {/* Стороны прямоугольника и есть размеры машины */}
                <button className="btn btn--sm btn--ghost btn--wide" onClick={confAddGabarit}>
                    {gab ? 'Выбрать габарит' : 'Задать габарит'}
                </button>
                <div className="tf-row">
                    <NumberField
                        label="Длина"
                        unit="м"
                        min={M_STEP}
                        step={M_STEP}
                        value={gab?.h ?? 0}
                        onCommit={v => confUpdateGabarit({ length: v })}
                    />
                    <NumberField
                        label="Ширина"
                        unit="м"
                        min={M_STEP}
                        step={M_STEP}
                        value={gab?.w ?? 0}
                        onCommit={v => confUpdateGabarit({ width: v })}
                    />
                </div>
                <NumberField
                    label="Высота"
                    unit="м"
                    min={0}
                    step={M_STEP}
                    value={confState.machineHeight}
                    onCommit={v => confUpdateMachineHeight(v)}
                />
                {/* Позиция задаётся центром: им же габарит ставится инструментом */}
                <div className="tf-row">
                    <NumberField
                        label="Центр X"
                        unit="м"
                        min={0}
                        step={M_STEP}
                        value={gab ? q(gab.x + gab.w / 2) : 0}
                        onCommit={v => confUpdateGabaritPos({ cx: v })}
                    />
                    <NumberField
                        label="Центр Y"
                        unit="м"
                        min={0}
                        step={M_STEP}
                        value={gab ? q(gab.y + gab.h / 2) : 0}
                        onCommit={v => confUpdateGabaritPos({ cy: v })}
                    />
                </div>
                <button className="btn btn--sm btn--ghost btn--wide" onClick={confCenterGabarit}>
                    Оцентровать
                </button>
            </div>

            <div className="blk-h">
                <h3>Камеры</h3>
                <span className="eyebrow spacer">{confState.cameras.length}</span>
                <button
                    className="icon-btn add"
                    data-tip="Добавить камеру · клик или перетащить на поле"
                    {...cameraDrag}
                >
                    <Icon name="plus" size={14} className="" />
                </button>
            </div>
            <div className={`blk-b list${confState.cameras.length ? '' : ' is-empty'}`}>
                <CameraList />
            </div>

            <div className="blk-h">
                <h3>Разметка</h3>
                <span className="eyebrow spacer">
                    {confState.zones.length}
                    {outside > 0 && ` · ${outside} вне камер`}
                </span>
                <button
                    className="icon-btn add"
                    data-tip="Добавить мат · клик или перетащить на поле"
                    {...zoneDrag}
                >
                    <Icon name="plus" size={14} className="" />
                </button>
            </div>
            <div className="blk-b pad mat">
                {/* Мат физический: сторона одна на все зоны и под камеру не ужимается */}
                <NumberField
                    label="Сторона мата"
                    unit="м"
                    min={M_STEP}
                    step={M_STEP}
                    value={confState.matSize}
                    onCommit={applyMat}
                />
            </div>
            <div className={`blk-b list${confState.zones.length ? '' : ' is-empty'}`}>
                <ZoneList />
            </div>

            <div className="blk-h">
                <h3>Рисунки</h3>
                <span className="eyebrow spacer">{confState.images.length}</span>
                <button
                    className="icon-btn add"
                    data-tip="Загрузить рисунок"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <Icon name="plus" size={14} className="" />
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) confAddImageFile(file);
                    }}
                />
            </div>
            <div className={`blk-b list${confState.images.length ? '' : ' is-empty'}`}>
                <ImageList />
            </div>

            <div className="sv-foot">
                <div className="tf">
                    <span className="tf-cap">Пресет</span>
                    <input
                        className="tf-in"
                        type="text"
                        value={confState.presetName}
                        onChange={e => {
                            confState.presetName = e.target.value;
                            emitConfChange();
                        }}
                    />
                </div>
                <button className="btn btn--acc btn--wide" onClick={onOpenExport}>
                    Рассчитать конфигурацию
                </button>
            </div>
        </aside>
    );
}
