import { useEffect, useState } from 'react';
import type { TrackerConfig, TrackerType } from '../../api/types';
import { neuralApi } from '../../api/client';

interface TrackerPanelProps {
    editing: boolean;
    tracker: TrackerConfig | null | undefined;
    /** '' — без трекера; иначе type выбранного трекера. */
    onTypeChange: (type: string) => void;
    onTrackerChange: (patch: Partial<TrackerConfig>) => void;
}

const HINTS = {
    iou_threshold: 'Степень наложения, при которой детекция попадает в существующий трек',
    min_hits: 'Сколько сопоставлений подряд нужно, чтобы трек стал подтверждённым (Confirmed)',
    max_lost: 'Сколько кадров-пропусков допускается для трека до его удаления',
    move_threshold: 'Насколько должен сместиться центр объекта, чтобы он считался сдвинувшимся',
};

/** Панель «Трекер (фильтр)»: сегмент выбора типа + карточки параметров.
 *  «без трекера» → tracker=null, карточки не показываются. */
export function TrackerPanel({ editing, tracker, onTypeChange, onTrackerChange }: TrackerPanelProps) {
    const [types, setTypes] = useState<TrackerType[]>([{ type: 'iou', name: 'IoU-трекер' }]);

    useEffect(() => {
        let alive = true;
        neuralApi
            .getTrackerTypes()
            .then((r) => alive && r.types?.length && setTypes(r.types))
            .catch(() => {
                /* бэкенд без ручки — остаёмся на дефолтном списке */
            });
        return () => {
            alive = false;
        };
    }, []);

    const options = [{ type: '', name: 'без трекера' }, ...types];
    const current = tracker?.type ?? '';

    return (
        <div className="panel">
            <div className="panel-header">
                <span className="panel-icon">⧉</span>
                <span className="panel-title">Трекер (фильтр)</span>
            </div>

            <div className="field-group">
                <span className="field-label">Тип трекера</span>
                <div className="trk-seg">
                    {options.map((o) => (
                        <button
                            key={o.type || 'none'}
                            type="button"
                            className={`trk-seg-btn${current === o.type ? ' active' : ''}`}
                            disabled={!editing}
                            onClick={() => onTypeChange(o.type)}
                        >
                            {o.name}
                        </button>
                    ))}
                </div>
            </div>

            {tracker && (
                <div className="trk-cards">
                    <CardField label="IoU порог" hint={HINTS.iou_threshold} value={tracker.iou_threshold} step="0.01" editing={editing} onChange={(v) => onTrackerChange({ iou_threshold: v })} />
                    <CardField label="Мин. кадров" hint={HINTS.min_hits} value={tracker.min_hits} step="1" editing={editing} onChange={(v) => onTrackerChange({ min_hits: v })} />
                    <CardField label="Макс. потерь" hint={HINTS.max_lost} value={tracker.max_lost} step="1" editing={editing} onChange={(v) => onTrackerChange({ max_lost: v })} />
                    <CardField label="Порог сдвига" hint={HINTS.move_threshold} value={tracker.move_threshold} step="0.01" editing={editing} onChange={(v) => onTrackerChange({ move_threshold: v })} />
                </div>
            )}
        </div>
    );
}

interface CardFieldProps {
    label: string;
    hint: string;
    value: number;
    step: string;
    editing: boolean;
    onChange: (v: number) => void;
}

function CardField({ label, hint, value, step, editing, onChange }: CardFieldProps) {
    return (
        <div className="trk-card">
            <div className="trk-card-top">
                <span className="trk-card-name">{label}</span>
                <input
                    className="field-input trk-card-input"
                    type="number"
                    step={step}
                    disabled={!editing}
                    value={value}
                    onWheel={(e) => e.currentTarget.blur()}
                    onChange={(e) => onChange(Number(e.target.value))}
                />
            </div>
            <span className="trk-card-hint">{hint}</span>
        </div>
    );
}
