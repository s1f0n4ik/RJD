import { useEffect, useState } from 'react';

/**
 * Числовое поле .tf: значение фиксируется по blur или Enter, не на каждое нажатие.
 * При контролируемом onChange с зажатым минимумом «500» набрать нельзя — «5» тут же станет минимумом.
 */

interface NumberFieldProps {
    label: string;
    value: number;
    min?: number;
    step?: number;
    /** Единица справа внутри поля: м, px */
    unit?: string;
    readOnly?: boolean;
    className?: string;
    onCommit: (value: number) => void;
}

export function NumberField({ label, value, min, step, unit, readOnly, className, onCommit }: NumberFieldProps) {
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
        <div className={`tf${unit ? ' tf-unit' : ''}${className ? ` ${className}` : ''}`}>
            <span className="tf-cap">{label}</span>
            <input
                className="tf-in"
                type="number"
                min={min}
                step={step}
                value={draft}
                readOnly={readOnly}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                // Колесо меняло значение под курсором и мешало ввести своё
                onWheel={e => e.currentTarget.blur()}
                onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                }}
            />
            {unit && <span className="u">{unit}</span>}
        </div>
    );
}
