import { useEffect, useRef, useState } from 'react';
import { confState, fmtM, getList, useConfStore } from '../../state/conf-store';
import type { ConfTool } from '../../types';
import { attachConfCanvas, confDraw, fitFieldToView } from './conf-canvas';
import { attachConfInteract } from './conf-interact';
import { confSelectTool } from './conf-actions';
import { ConfiguratorPanel } from './ConfiguratorPanel';
import { ExportModal } from './ExportModal';
import { LoadPresetModal } from './LoadPresetModal';
import { importPreset } from './conf-import';
import { confDraw as redraw } from './conf-canvas';
import { useToast } from '../common/Toast';

/** Экран «Конфигуратор». Порт page-4 из birdview.html. */

const TOOLS: Array<{ id: ConfTool; icon: string; title: string }> = [
    { id: 'select', icon: '⊹', title: 'Выделение: перетаскивание, размер, поворот' },
    { id: 'camera', icon: '◱', title: 'Камера (Shift+Q): растяните область в пределах поля' },
    { id: 'zone', icon: '▦', title: 'Разметка (Shift+W): ПКМ — выбрать камеру, ЛКМ — поставить мат внутри неё' },
];

interface ConfiguratorScreenProps {
    active: boolean;
}

export function ConfiguratorScreen({ active }: ConfiguratorScreenProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cursorRef = useRef<HTMLSpanElement>(null);
    const cornerRef = useRef<HTMLSpanElement>(null);
    const activeRef = useRef(active);
    activeRef.current = active;

    const [panelOpen, setPanelOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [loadOpen, setLoadOpen] = useState(false);
    const showToast = useToast();
    const toastRef = useRef(showToast);
    toastRef.current = showToast;

    useConfStore();

    const sel = confState.selected;
    const selected = sel ? getList(sel.type).find(i => i.id === sel.id) : undefined;

    // Угол выделенного меняется на каждый pointermove при драге и ресайзе,
    // поэтому пишется в DOM мимо React — как и позиция курсора
    const writeCorner = () => {
        const el = cornerRef.current;
        if (!el) return;
        const s = confState.selected;
        const item = s ? getList(s.type).find(i => i.id === s.id) : undefined;
        el.textContent = item ? `⌈ X ${fmtM(item.x)} Y ${fmtM(item.y)}` : '⌈ X — Y —';
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const detachCanvas = attachConfCanvas(canvas);
        const detachInteract = attachConfInteract(canvas, {
            // Позиция курсора пишется в DOM напрямую: она меняется на каждый
            // pointermove, через React это был бы ре-рендер на кадр.
            onCursor: (wx, wy) => {
                if (cursorRef.current) {
                    cursorRef.current.textContent = `X: ${wx.toFixed(3)} Y: ${wy.toFixed(3)}`;
                }
                writeCorner();
            },
            isActive: () => activeRef.current,
            onNotice: (title, desc, type) => toastRef.current(title, desc, type),
        });

        return () => {
            detachInteract();
            detachCanvas();
        };
    }, []);

    // Догоняет правки без мыши: ввод чисел в панели, поворот по r, центровку по c
    useEffect(writeCorner);

    // Экран скрыт через display:none, поэтому при возврате на него холст мог
    // остаться отрисованным на нулевом размере.
    useEffect(() => {
        if (active) confDraw();
    }, [active]);

    const f = confState.field;

    return (
        <main className={`main-layout conf-layout ${active ? '' : 'hidden'}`}>
            <section className="conf-canvas-area">
                <canvas ref={canvasRef} className="conf-canvas" />

                <div className="conf-toolbar">
                    {TOOLS.map(tool => (
                        <button
                            key={tool.id}
                            className={`conf-tool-btn ${confState.tool === tool.id ? 'active' : ''}`}
                            onClick={() => confSelectTool(tool.id)}
                            title={tool.title}
                        >
                            {tool.icon}
                        </button>
                    ))}

                    {/* Загрузка не инструмент рисования, поэтому отделена чертой */}
                    <span className="conf-tool-sep" />
                    <button
                        className="conf-tool-btn"
                        onClick={() => setLoadOpen(true)}
                        title="Загрузить сохранённую конфигурацию для правки"
                    >
                        ⭳
                    </button>
                </div>

                <div className="conf-status-bar">
                    <span className="meta-tag">Поле: {fmtM(f.w)}×{fmtM(f.h)} м</span>
                    <span className="meta-tag">Шаг: {fmtM(f.step)} м</span>
                    <span className="meta-tag">{confState.pxPerM} px/м</span>
                    <span ref={cursorRef} className="meta-tag">X: — Y: —</span>
                </div>

                {/* Появляется только при выделении; уезжает влево от открытой панели */}
                {selected && (
                    <div className={`conf-corner-bar ${panelOpen ? 'shifted' : ''}`}>
                        <span ref={cornerRef} className="meta-tag">⌈ X — Y —</span>
                    </div>
                )}
            </section>

            <button
                className={`conf-panel-tab ${panelOpen ? 'open' : ''}`}
                onClick={() => setPanelOpen(o => !o)}
            >
                <span className="conf-panel-tab-icon">⊞</span>
                <span className="conf-panel-tab-label">Инструменты</span>
            </button>

            <ConfiguratorPanel open={panelOpen} onOpenExport={() => setExportOpen(true)} />

            {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}

            {loadOpen && (
                <LoadPresetModal
                    dirty={confState.cameras.length > 0 || confState.zones.length > 0}
                    onClose={() => setLoadOpen(false)}
                    onLoad={async key => {
                        try {
                            const res = await fetch(
                                `/linker/preset?key=${encodeURIComponent(key)}`,
                                { headers: { Accept: 'application/json' } },
                            );
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);

                            const json = await res.json();
                            const data = json.data ?? json;
                            const result = await importPreset(data);

                            // Запоминаем источник: экспорт предзаполнится им для перезаписи
                            confState.presetId = key;
                            confState.presetName = typeof data?.name === 'string' ? data.name : '';

                            setLoadOpen(false);
                            // Поле пресета в метрах может отличаться от текущего
                            // в разы, и старый масштаб вида к нему не подходит
                            fitFieldToView();
                            redraw();

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
                                // Тост знает только ok, err и info: пропущенные
                                // подложки — не отказ, но и не полный успех
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
        </main>
    );
}
