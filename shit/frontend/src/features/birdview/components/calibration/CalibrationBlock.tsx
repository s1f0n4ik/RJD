import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { useToast } from '../common/Toast';

// Блок «Шаблон и снимки»: размер шахматки, снимки, запуск расчёта

export interface PatternInfo {
    width: number | string;
    height: number | string;
    size: number | string;
}

interface CalibrationBlockProps {
    // Шаблон уже задан на сервере: показываем его в шапке блока
    patternSet: boolean;
    pattern: PatternInfo | null;
    onSavePattern: (p: { width: number; height: number; size: number }) => void;
    snapshotCount: number;
    onTakeSnapshot: () => void;
    onClearSnapshots: () => void;
    onStartCalibration: () => void;
}

type Draft = { width: string; height: string; size: string };

const asDraft = (p: PatternInfo | null): Draft => ({
    width: p?.width != null && p.width !== '—' ? String(p.width) : '',
    height: p?.height != null && p.height !== '—' ? String(p.height) : '',
    size: p?.size != null && p.size !== '—' ? String(p.size) : '',
});

const same = (a: string, b: string) => {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
    return a.trim() === b.trim();
};

export function CalibrationBlock({
    patternSet,
    pattern,
    onSavePattern,
    snapshotCount,
    onTakeSnapshot,
    onClearSnapshots,
    onStartCalibration,
}: CalibrationBlockProps) {
    const [draft, setDraft] = useState<Draft>(() => asDraft(pattern));
    const serverRef = useRef<Draft>(asDraft(pattern));
    const showToast = useToast();

    // Ответ калибратора подставляем только в те поля, которых оператор не касался
    useEffect(() => {
        const next = asDraft(pattern);
        const prev = serverRef.current;
        serverRef.current = next;
        setDraft(d => ({
            width: same(d.width, prev.width) ? next.width : d.width,
            height: same(d.height, prev.height) ? next.height : d.height,
            size: same(d.size, prev.size) ? next.size : d.size,
        }));
    }, [pattern?.width, pattern?.height, pattern?.size]);

    const dirty =
        !same(draft.width, serverRef.current.width) ||
        !same(draft.height, serverRef.current.height) ||
        !same(draft.size, serverRef.current.size);

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

    const field = (key: keyof Draft, placeholder: string, step?: string) => (
        <input
            className="tf-in"
            type="number"
            step={step}
            placeholder={placeholder}
            value={draft[key]}
            onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
            onWheel={e => e.currentTarget.blur()}
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
                    <span className="eyebrow spacer">{`${pattern.width}×${pattern.height} · ${pattern.size} мм`}</span>
                )}
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
                    <button
                        className="icon-btn ib-tf"
                        data-tip="Задать шаблон"
                        onClick={handleSave}
                        disabled={!dirty}
                    >
                        <Icon name="save" size={15} />
                    </button>
                </div>

                <div className="snapbar">
                    <span className={`cnt${snapshotCount === 0 ? ' zero' : ''}`}>{snapshotCount}</span>
                    <span className="lbl">снимков</span>
                    <span className="acts">
                        <button className="icon-btn" data-tip="Снять кадр" onClick={onTakeSnapshot}>
                            <Icon name="cam" size={16} />
                        </button>
                        <button
                            className="icon-btn"
                            data-tip="Удалить все снимки"
                            onClick={onClearSnapshots}
                            disabled={snapshotCount === 0}
                        >
                            <Icon name="trash" size={15} />
                        </button>
                    </span>
                </div>

                <button className="btn btn--acc btn--wide" onClick={onStartCalibration}>
                    Рассчитать калибровку
                </button>
            </div>
        </>
    );
}
