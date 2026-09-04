import { useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { useToast } from '../common/Toast';

// Блок «Шаблон и снимки»: размер шахматки, снимки, запуск расчёта

export interface PatternInfo {
    width: number | string;
    height: number | string;
    size: number | string;
}

interface CalibrationBlockProps {
    // Шаблон уже задан на сервере: поля только для чтения
    patternSet: boolean;
    pattern: PatternInfo | null;
    onSavePattern: (p: { width: number; height: number; size: number }) => void;
    snapshotCount: number;
    onTakeSnapshot: () => void;
    onClearSnapshots: () => void;
    onStartCalibration: () => void;
}

export function CalibrationBlock({
    patternSet,
    pattern,
    onSavePattern,
    snapshotCount,
    onTakeSnapshot,
    onClearSnapshots,
    onStartCalibration,
}: CalibrationBlockProps) {
    const [draft, setDraft] = useState({ width: '', height: '', size: '' });
    const showToast = useToast();

    // Калибратор отвергает неполный шаблон молча, проверка здесь
    const handleSave = () => {
        const width = parseInt(draft.width, 10);
        const height = parseInt(draft.height, 10);
        const size = parseFloat(draft.size);

        const missing: string[] = [];
        if (!Number.isFinite(width) || width <= 0) missing.push('столбцы');
        if (!Number.isFinite(height) || height <= 0) missing.push('строки');
        if (!Number.isFinite(size) || size <= 0) missing.push('клетка');

        if (missing.length) {
            showToast('Шаблон не задан', `Заполните: ${missing.join(', ')}`, 'err');
            return;
        }

        onSavePattern({ width, height, size });
    };

    const field = (key: keyof typeof draft, placeholder: string, step?: string) =>
        patternSet ? (
            <input className="tf-in" readOnly value={String(pattern?.[key] ?? '—')} />
        ) : (
            <input
                className="tf-in"
                type="number"
                step={step}
                placeholder={placeholder}
                value={draft[key]}
                onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                onKeyDown={e => {
                    if (e.key === 'Enter') handleSave();
                }}
            />
        );

    return (
        <>
            <div className="blk-h">
                <h3>Шаблон и снимки</h3>
                {patternSet && pattern && (
                    <span className="eyebrow">{`${pattern.width}×${pattern.height} · ${pattern.size} мм`}</span>
                )}
                <span className={`pill spacer${snapshotCount > 0 ? ' ok' : ''}`}>
                    <span className="dot" />
                    снимков {snapshotCount}
                </span>
            </div>
            <div className="blk-b pad">
                <div className="tf-row">
                    <div className="tf">
                        <span className="tf-cap">Столбцов</span>
                        {field('width', '9')}
                    </div>
                    <div className="tf">
                        <span className="tf-cap">Строк</span>
                        {field('height', '6')}
                    </div>
                    <div className="tf tf-unit">
                        <span className="tf-cap">Клетка</span>
                        {field('size', '25', '0.1')}
                        <span className="u">мм</span>
                    </div>
                </div>

                {!patternSet && (
                    <button className="btn btn--sm" onClick={handleSave}>
                        Задать шаблон
                    </button>
                )}

                <div className="brow">
                    <button className="icon-btn ib-lg" data-tip="Снять кадр" onClick={onTakeSnapshot}>
                        <Icon name="cam" size={17} />
                    </button>
                    <button
                        className="icon-btn ib-lg"
                        data-tip="Удалить все снимки"
                        onClick={onClearSnapshots}
                        disabled={snapshotCount === 0}
                    >
                        <Icon name="trash" size={16} />
                    </button>
                    <button className="btn btn--acc" style={{ flex: 1 }} onClick={onStartCalibration}>
                        Рассчитать калибровку
                    </button>
                </div>
            </div>
        </>
    );
}
