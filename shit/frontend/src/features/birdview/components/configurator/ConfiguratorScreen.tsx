import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import type { IconName } from '../../../../app/Icons';
import { confState, fmtM, getList, useConfStore } from '../../state/conf-store';
import type { ConfSelection, ConfTool, ConfZone } from '../../types';
import {
    attachConfCanvas,
    confDraw,
    fitFieldToView,
    zoneCameras,
    zoneGaps,
    zoneRotationFor,
} from './conf-canvas';
import { attachConfInteract } from './conf-interact';
import { confSelectTool, confToggleCrosshair } from './conf-actions';
import { ConfiguratorPanel } from './ConfiguratorPanel';
import { ExportModal } from './ExportModal';
import { AddZoneModal } from './AddZoneModal';
import { ElementModal } from './ElementModal';
import { LoadPresetModal } from './LoadPresetModal';
import { importPreset } from './conf-import';
import { linkerPath } from '../../api/linker';
import { useToast } from '../common/Toast';
import '../../../../screens/surround/configurator.css';

// Экран «Конфигуратор»: холст с полем и постоянная панель справа

const TOOLS: Array<{ id: ConfTool; icon: IconName; tip: string }> = [
    { id: 'select', icon: 'cursor', tip: 'Выделение' },
    { id: 'camera', icon: 'cam', tip: 'Камера · ⇧Q · растянуть область' },
    { id: 'zone', icon: 'zone', tip: 'Разметка · ⇧W · поставить мат' },
    { id: 'gabarit', icon: 'gab', tip: 'Габарит · поставить центром' },
];

// Шаг кнопок масштаба — как у колеса в conf-interact
const ZOOM_STEP = 1.12;

const ITEM_LABEL: Record<ConfSelection['type'], string> = {
    camera: 'камера',
    zone: 'зона',
    image: 'рисунок',
    gabarit: 'габарит',
};

// Масштаб «вписать»: тот же расчёт, что в fitFieldToView
function fitScale(area: HTMLElement): number {
    const f = confState.field;
    return Math.min(area.offsetWidth / f.w, area.offsetHeight / f.h) * 0.9;
}

interface ConfiguratorScreenProps {
    active: boolean;
}

export function ConfiguratorScreen({ active }: ConfiguratorScreenProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cursorRef = useRef<HTMLSpanElement>(null);
    const cornerRef = useRef<HTMLSpanElement>(null);
    const rotRef = useRef<HTMLSpanElement>(null);
    const zoomRef = useRef<HTMLSpanElement>(null);
    const activeRef = useRef(active);
    activeRef.current = active;

    const [exportOpen, setExportOpen] = useState(false);
    const [loadOpen, setLoadOpen] = useState(false);
    const [addZoneOpen, setAddZoneOpen] = useState(false);
    const [elementMenu, setElementMenu] = useState<ConfSelection | null>(null);
    const menuRef = useRef(setElementMenu);
    menuRef.current = setElementMenu;
    const showToast = useToast();
    const toastRef = useRef(showToast);
    toastRef.current = showToast;

    useConfStore();

    const sel = confState.selected;
    const selected = sel ? getList(sel.type).find(i => i.id === sel.id) : undefined;

    // Угол, зазоры и масштаб меняются на каждый pointermove и колесо,
    // поэтому пишутся в DOM мимо React — как и позиция курсора
    const writeCorner = () => {
        const s = confState.selected;
        const item = s ? getList(s.type).find(i => i.id === s.id) : undefined;

        if (cornerRef.current) {
            if (!item || !s) {
                cornerRef.current.textContent = '';
            } else {
                const name = 'name' in item && item.name ? item.name : ITEM_LABEL[s.type];
                const gaps = s.type === 'zone' ? zoneGaps(item as ConfZone) : null;
                if (gaps) {
                    const link = confState.measureRef;
                    const ref = link && link.fromId === item.id
                        ? confState.zones.find(z => z.id === link.toId)
                        : undefined;
                    const target = ref ? ref.name : 'габарита';
                    cornerRef.current.textContent =
                        `${name} · до ${target} x ${fmtM(gaps.x)} · y ${fmtM(gaps.y)}`;
                } else {
                    cornerRef.current.textContent = `${name} · x ${fmtM(item.x)} · y ${fmtM(item.y)}`;
                }
            }
        }

        if (rotRef.current) {
            const zone = item && s?.type === 'zone' ? (item as ConfZone) : null;
            const cams = zone ? zoneCameras(zone) : [];
            rotRef.current.hidden = cams.length === 0;
            if (zone && cams.length) {
                const degs = Array.from(new Set(cams.map(cam => zoneRotationFor(cam, zone))));
                rotRef.current.textContent = `поворот ${degs.map(d => `${d}°`).join(' / ')}`;
            }
        }
    };

    const writeZoom = () => {
        const el = zoomRef.current;
        const area = canvasRef.current?.parentElement;
        if (!el || !area || !area.offsetWidth || !area.offsetHeight) return;
        el.textContent = `${Math.round((confState.view.scale / fitScale(area)) * 100)} %`;
    };

    // Масштаб вокруг центра холста с пределами колеса из conf-interact
    const zoomBy = (factor: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const v = confState.view;
        const mx = canvas.clientWidth / 2;
        const my = canvas.clientHeight / 2;
        const prev = v.scale;
        const side = Math.max(confState.field.w, confState.field.h);
        v.scale = Math.min(20000 / side, Math.max(10 / side, prev * factor));
        const ratio = v.scale / prev;
        v.ox = mx - (mx - v.ox) * ratio;
        v.oy = my - (my - v.oy) * ratio;
        confDraw();
        writeZoom();
    };

    const fitView = () => {
        fitFieldToView();
        confDraw();
        writeZoom();
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const detachCanvas = attachConfCanvas(canvas);
        const detachInteract = attachConfInteract(canvas, {
            // Позиция курсора пишется в DOM напрямую: она меняется на каждый pointermove
            onCursor: (wx, wy) => {
                if (cursorRef.current) {
                    cursorRef.current.textContent = `x ${wx.toFixed(3)} · y ${wy.toFixed(3)}`;
                }
                writeCorner();
            },
            isActive: () => activeRef.current,
            onNotice: (title, desc, type) => toastRef.current(title, desc, type),
            onElementMenu: sel => menuRef.current(sel),
        });

        // Слушатель зарегистрирован после обработчика колеса, поэтому видит уже новый масштаб
        canvas.addEventListener('wheel', writeZoom, { passive: true });
        const observer = new ResizeObserver(writeZoom);
        if (canvas.parentElement) observer.observe(canvas.parentElement);

        return () => {
            observer.disconnect();
            canvas.removeEventListener('wheel', writeZoom);
            detachInteract();
            detachCanvas();
        };
    }, []);

    // Догоняет правки без мыши: ввод чисел в панели, центровку по c, смену поля
    useEffect(() => {
        writeCorner();
        writeZoom();
    });

    // Экран скрыт через display:none, поэтому при возврате на него холст мог
    // остаться отрисованным на нулевом размере
    useEffect(() => {
        if (active) {
            confDraw();
            writeZoom();
        }
    }, [active]);

    const f = confState.field;

    return (
        <div className={`sv sv-conf${active ? '' : ' is-hidden'}`}>
            <div className="sv-main">
                <div className="toolbar">
                    {TOOLS.map(tool => (
                        <button
                            key={tool.id}
                            className={`tool ic${confState.tool === tool.id ? ' is-on' : ''}`}
                            data-tip={tool.tip}
                            onClick={() => confSelectTool(tool.id)}
                        >
                            <Icon name={tool.icon} />
                        </button>
                    ))}

                    <span className="tbar-sep" />
                    <button className="btn btn--sm" onClick={() => setLoadOpen(true)}>
                        <Icon name="arch" />
                        Загрузить
                    </button>
                    <button
                        className={`tool ic${confState.showCrosshair ? ' is-on' : ''}`}
                        data-tip="Перекрестие по узлам сетки"
                        onClick={() => confToggleCrosshair(!confState.showCrosshair)}
                    >
                        <Icon name="plus" />
                    </button>

                    <div className="zoom">
                        <button data-tip="Отдалить" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
                        <span ref={zoomRef} className="num">— %</span>
                        <button data-tip="Приблизить" onClick={() => zoomBy(ZOOM_STEP)}>+</button>
                        <button data-tip="Вписать поле" onClick={fitView}>
                            <Icon name="full" size={15} className="" />
                        </button>
                    </div>
                </div>

                <div className="canvas-wrap">
                    <div className="plan">
                        <div className="conf-area">
                            <canvas ref={canvasRef} />
                        </div>
                    </div>
                </div>

                <div className="sv-status">
                    <span className="pill num">поле {fmtM(f.w)} × {fmtM(f.h)} м</span>
                    <span className="pill num">шаг {fmtM(f.step)} м</span>
                    <span className="pill num">{confState.pxPerM} px/м</span>
                    <span ref={cursorRef} className="pill num">x — · y —</span>
                </div>

                {selected && (
                    <div className="sv-corner">
                        <span ref={cornerRef} className="pill num acc" />
                        {sel?.type === 'zone' && <span ref={rotRef} className="pill num" hidden />}
                    </div>
                )}
            </div>

            <ConfiguratorPanel
                onOpenExport={() => setExportOpen(true)}
                onOpenAddZone={() => setAddZoneOpen(true)}
            />

            {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}

            {addZoneOpen && <AddZoneModal onClose={() => setAddZoneOpen(false)} />}

            {elementMenu && (
                <ElementModal
                    type={elementMenu.type}
                    id={elementMenu.id}
                    onClose={() => setElementMenu(null)}
                />
            )}

            {loadOpen && (
                <LoadPresetModal
                    dirty={confState.cameras.length > 0 || confState.zones.length > 0}
                    onClose={() => setLoadOpen(false)}
                    onLoad={async key => {
                        try {
                            const res = await fetch(
                                linkerPath(`/linker/preset?key=${encodeURIComponent(key)}`),
                                { headers: { Accept: 'application/json' } },
                            );
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);

                            const json = await res.json();
                            const data = json.data ?? json;
                            const result = await importPreset(data);

                            // Источник запоминается: экспорт предзаполнится им для перезаписи
                            confState.presetId = key;
                            confState.presetName = typeof data?.name === 'string' ? data.name : '';

                            setLoadOpen(false);
                            // Поле пресета может отличаться в разы, старый масштаб вида к нему не подходит
                            fitView();

                            const parts = [
                                `${result.cameras} камер`,
                                `${result.zones} областей`,
                            ];
                            if (result.images) parts.push(`${result.images} подложек`);

                            showToast(
                                'Загружено',
                                parts.join(', ') +
                                    (result.missingImages.length
                                        ? `. Не найдены на сервере: ${result.missingImages.join(', ')}`
                                        : ''),
                                result.missingImages.length ? 'info' : 'ok',
                            );
                        } catch (e) {
                            showToast(
                                'Не удалось загрузить',
                                e instanceof Error ? e.message : String(e),
                                'err',
                            );
                        }
                    }}
                />
            )}
        </div>
    );
}
