import { useEffect, useState } from 'react';

/**
 * Числовое поле, которое фиксирует значение по blur или Enter, а не на каждое
 * нажатие клавиши.
 *
 * Нужно там, где значение при записи пережимается (ширина поля не может быть
 * меньше трёх шагов привязки): при контролируемом инпуте с onChange набрать
 * «500» невозможно — «5» тут же превратится в минимум. В no-react это работало
 * потому, что инпуты были неконтролируемыми с onchange, то есть по blur.
 */

interface NumberFieldProps {
    label: string;
    value: number;
    min?: number;
    step?: number;
    onCommit: (value: number) => void;
}

export function NumberField({ label, value, min, step, onCommit }: NumberFieldProps) {
    const [draft, setDraft] = useState(String(value));

    // Значение могло измениться снаружи — например, пережаться при правке поля
    useEffect(() => {
        setDraft(String(value));
    }, [value]);

    const commit = () => {
        const parsed = Number(draft);
        if (Number.isFinite(parsed)) onCommit(parsed);
        else setDraft(String(value));
    };

    return (
        <div className="field-group">
            <label className="field-label">{label}</label>
            <input
                className="field-input"
                type="number"
                min={min}
                step={step}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                // Колесо меняло значение под курсором и мешало ввести своё
                onWheel={e => e.currentTarget.blur()}
                onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                }}
            />
        </div>
    );
}
