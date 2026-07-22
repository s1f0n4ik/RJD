import { useState } from 'react';
import { useToast } from '../common/Toast';

/** Параметры калибровки: паттерн, шахматка, снимки, запуск. Порт calibrationBlock. */

export interface PatternInfo {
    width: number | string;
    height: number | string;
    size: number | string;
}

interface CalibrationBlockProps {
    visible: boolean;
    /** Паттерн уже задан на сервере — блок сворачивается и получает отметку. */
    patternSet: boolean;
    pattern: PatternInfo | null;
    onSavePattern: (p: { width: number; height: number; size: number }) => void;
    chessboard: boolean;
    onToggleChessboard: () => void;
    snapshotCount: number;
    onTakeSnapshot: () => void;
    onStartCalibration: () => void;
}

export function CalibrationBlock({
    visible,
    patternSet,
    pattern,
    onSavePattern,
    chessboard,
    onToggleChessboard,
    snapshotCount,
    onTakeSnapshot,
    onStartCalibration,
}: CalibrationBlockProps) {
    const [draft, setDraft] = useState({ width: '', height: '', size: '' });
    const showToast = useToast();

    // Калибратор отвергает неполный паттерн молча, поэтому проверяем здесь
    const handleSave = () => {
        const width = parseInt(draft.width, 10);
        const height = parseInt(draft.height, 10);
        const size = parseFloat(draft.size);

        const missing: string[] = [];
        if (!Number.isFinite(width) || width <= 0) missing.push('ширина');
        if (!Number.isFinite(height) || height <= 0) missing.push('длина');
        if (!Number.isFinite(size) || size <= 0) missing.push('размер ячейки');

        if (missing.length) {
            showToast('Паттерн не сохранён', `Заполните: ${missing.join(', ')}`, 'err');
            return;
        }

        onSavePattern({ width, height, size });
    };

    return (
        <section className={`panel-block panel-block--hidden${visible ? ' visible' : ''}`}>
            <div className="block-header">
                <span className="block-icon">⊞</span>
                <span className="block-title">Параметры калибровки</span>
            </div>

            <details className="collapsible" {...(patternSet ? { 'data-set': '' } : {})} open={!patternSet}>
                <summary className="collapsible-header">
                    <span>Паттерн{patternSet && pattern ? ` — ${pattern.width}×${pattern.height} · ${pattern.size} мм` : ''}</span>
                    <span className="collapsible-arrow">›</span>
                </summary>
                <div className="collapsible-body">
                    <div className="field-row">
                        <div className="field-group">
                            <label className="field-label">Ширина</label>
                            <input
                                className="field-input"
                                type="number"
                                placeholder="9"
                                value={draft.width}
                                onChange={e => setDraft(d => ({ ...d, width: e.target.value }))}
                            />
                        </div>
                        <div className="field-group">
                            <label className="field-label">Длина</label>
                            <input
                                className="field-input"
                                type="number"
                                placeholder="6"
                                value={draft.height}
                                onChange={e => setDraft(d => ({ ...d, height: e.target.value }))}
                            />
                        </div>
                    </div>
                    <div className="field-group">
                        <label className="field-label">Размер ячейки (мм)</label>
                        <input
                            className="field-input"
                            type="number"
                            step="0.1"
                            placeholder="25.0"
                            value={draft.size}
                            onChange={e => setDraft(d => ({ ...d, size: e.target.value }))}
                        />
                    </div>
                    <button
                        className="btn btn-ghost btn-sm"
                        style={{ width: '100%', marginTop: 2 }}
                        onClick={handleSave}
                    >
                        ✓ Сохранить паттерн
                    </button>
                </div>
            </details>

            <label className="toggle-row">
                <span className="toggle-label">Обнаружение шахматки</span>
                <input
                    className="toggle-input"
                    type="checkbox"
                    checked={chessboard}
                    onChange={onToggleChessboard}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
            </label>

            <div className="snapshot-row">
                <button className="btn btn-accent" onClick={onTakeSnapshot} style={{ flex: 1 }}>
                    <span>⊙ Сделать снимок</span>
                </button>
                <div className="snapshot-counter">
                    <span className="counter-num">{snapshotCount}</span>
                    <span className="counter-label">кадров</span>
                </div>
            </div>

            <button
                className="btn btn-calibrate"
                style={{ width: '100%', marginTop: 2 }}
                onClick={onStartCalibration}
            >
                Начать калибровку
            </button>
        </section>
    );
}
