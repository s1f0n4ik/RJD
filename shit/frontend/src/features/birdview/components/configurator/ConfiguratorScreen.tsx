import { useEffect, useRef, useState } from 'react';
import { confState, useConfStore } from '../../state/conf-store';
import type { ConfTool } from '../../types';
import { attachConfCanvas, confDraw } from './conf-canvas';
import { attachConfInteract } from './conf-interact';
import { confSelectTool } from './conf-actions';
import { ConfiguratorPanel } from './ConfiguratorPanel';
import { ExportModal } from './ExportModal';
import { useToast } from '../common/Toast';

/** Экран «Конфигуратор». Порт page-4 из birdview.html. */

const TOOLS: Array<{ id: ConfTool; icon: string; title: string }> = [
    { id: 'select', icon: '⊹', title: 'Выделение: перетаскивание, размер, поворот' },
    { id: 'camera', icon: '◱', title: 'Камера (Shift+Q): растяните область в пределах поля' },
    { id: 'zone', icon: '▦', title: 'Разметка (Shift+W): ПКМ — выбрать камеру, ЛКМ — нарисовать область внутри неё' },
];

interface ConfiguratorScreenProps {
    active: boolean;
}

export function ConfiguratorScreen({ active }: ConfiguratorScreenProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cursorRef = useRef<HTMLSpanElement>(null);
    const activeRef = useRef(active);
    activeRef.current = active;

    const [panelOpen, setPanelOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const showToast = useToast();
    const toastRef = useRef(showToast);
    toastRef.current = showToast;

    useConfStore();

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const detachCanvas = attachConfCanvas(canvas);
        const detachInteract = attachConfInteract(canvas, {
            // Позиция курсора пишется в DOM напрямую: она меняется на каждый
            // pointermove, через React это был бы ре-рендер на кадр.
            onCursor: (wx, wy) => {
                if (cursorRef.current) {
                    cursorRef.current.textContent = `X: ${Math.round(wx)} Y: ${Math.round(wy)}`;
                }
            },
            isActive: () => activeRef.current,
            onNotice: (title, desc, type) => toastRef.current(title, desc, type),
        });

        return () => {
            detachInteract();
            detachCanvas();
        };
    }, []);

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
                </div>

                <div className="conf-status-bar">
                    <span className="meta-tag">Поле: {f.w}×{f.h}</span>
                    <span className="meta-tag">Шаг: {f.step}</span>
                    <span ref={cursorRef} className="meta-tag">X: — Y: —</span>
                </div>
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
        </main>
    );
}
