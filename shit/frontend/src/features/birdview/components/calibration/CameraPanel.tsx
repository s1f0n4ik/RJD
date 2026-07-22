import { useEffect, useState } from 'react';
import { fetchCalibrationCameras } from '../../api/cameras';
import { CustomSelect } from '../common/CustomSelect';
import type { CalibrationCamera } from '../../api/ws-types';

/** Выбор камеры и управление стримом. Порт блока «Камера» из page-1. */

interface CameraPanelProps {
    camera: CalibrationCamera | null;
    onSelectCamera: (cam: CalibrationCamera) => void;
    streaming: boolean;
    canStream: boolean;
    onToggleStream: () => void;
    onLoadConfiguration: () => void;
}

export function CameraPanel({
    camera,
    onSelectCamera,
    streaming,
    canStream,
    onToggleStream,
    onLoadConfiguration,
}: CameraPanelProps) {
    const [cameras, setCameras] = useState<CalibrationCamera[]>([]);
    const [error, setError] = useState(false);

    useEffect(() => {
        let alive = true;
        fetchCalibrationCameras()
            .then(list => {
                if (alive) setCameras(list);
            })
            .catch(() => {
                if (alive) setError(true);
            });
        return () => {
            alive = false;
        };
    }, []);

    return (
        <section className="panel-block">
            <div className="block-header">
                <span className="block-icon">◉</span>
                <span className="block-title">Камера</span>
            </div>

            <div className={`camera-fields${streaming ? ' collapsed' : ''}`}>
                <div className="field-group">
                    <label className="field-label">Камера</label>
                    <CustomSelect
                        options={cameras.map(c => ({ value: c.id, label: c.displayName }))}
                        value={camera?.id ?? null}
                        placeholder="Выберите камеру"
                        emptyText={error ? 'Ошибка загрузки' : 'Нет доступных камер'}
                        onChange={id => {
                            const found = cameras.find(c => c.id === id);
                            if (found) onSelectCamera(found);
                        }}
                    />
                </div>

                <div className="field-row">
                    <div className="field-group">
                        <label className="field-label">Ширина</label>
                        <input className="field-input" type="number" readOnly value={camera?.width ?? ''} />
                    </div>
                    <div className="field-group">
                        <label className="field-label">Высота</label>
                        <input className="field-input" type="number" readOnly value={camera?.height ?? ''} />
                    </div>
                </div>
            </div>

            <button
                className={`btn btn-accent--load${streaming ? '' : ' collapsed'}`}
                onClick={onLoadConfiguration}
            >
                <span>Загрузить конфигурацию</span>
            </button>

            <button
                className={`btn btn-accent btn-stream${streaming ? ' streaming' : ''}`}
                onClick={onToggleStream}
                disabled={!canStream}
            >
                <span>{streaming ? '■ Закрыть стрим' : '▶ Запустить стрим'}</span>
            </button>
        </section>
    );
}
