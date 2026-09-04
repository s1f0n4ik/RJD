import { useEffect, useState } from 'react';
import { fetchCalibrationCameras } from '../../api/cameras';
import { CustomSelect } from '../common/CustomSelect';
import type { CalibrationCamera } from '../../api/ws-types';

// Блок «Камера»: выбор камеры, разрешение, загруженная конфигурация, поток

interface CameraPanelProps {
    camera: CalibrationCamera | null;
    onSelectCamera: (cam: CalibrationCamera) => void;
    // Камера подходит под выбранную конфигурацию коррекции
    fits: (cam: CalibrationCamera) => boolean;
    loadedKey: string | null;
    streamOpen: boolean;
    pending: boolean;
    wsReady: boolean;
    onToggleStream: () => void;
    onLoadConfiguration: () => void;
}

export function CameraPanel({
    camera,
    onSelectCamera,
    fits,
    loadedKey,
    streamOpen,
    pending,
    wsReady,
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

    const streamLabel = pending ? 'Подключение…' : streamOpen ? 'Остановить поток' : 'Запустить поток';

    return (
        <>
            <div className="blk-h">
                <h3>Камера</h3>
            </div>
            <div className="blk-b pad">
                <div className="tf">
                    <span className="tf-cap">Камера</span>
                    <CustomSelect
                        options={cameras.map(c => ({
                            value: c.id,
                            label: c.displayName,
                            note: `${c.width}×${c.height}`,
                            muted: !fits(c),
                        }))}
                        value={camera?.id ?? null}
                        placeholder="Выберите камеру"
                        emptyText={error ? 'Ошибка загрузки' : 'Нет доступных камер'}
                        onChange={id => {
                            const found = cameras.find(c => c.id === id);
                            if (found) onSelectCamera(found);
                        }}
                    />
                </div>

                <div className="tf-row">
                    <div className="tf">
                        <span className="tf-cap">Разрешение</span>
                        <input className="tf-in" readOnly value={camera ? `${camera.width}×${camera.height}` : '—'} />
                    </div>
                    <div className="tf">
                        <span className="tf-cap">Кадров/с</span>
                        <input className="tf-in" readOnly value={camera ? String(camera.fps) : '—'} />
                    </div>
                </div>

                <div className="tf">
                    <span className="tf-cap">Загружена конфигурация</span>
                    <input
                        className="tf-in"
                        readOnly
                        value={loadedKey ?? '—'}
                        title={loadedKey ?? undefined}
                        style={loadedKey ? { color: 'var(--ok)' } : undefined}
                    />
                </div>

                <div className="brow">
                    <button className="btn btn--sm" onClick={onToggleStream} disabled={pending || !wsReady}>
                        {streamLabel}
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={onLoadConfiguration} disabled={!wsReady}>
                        Загрузить конфигурацию
                    </button>
                </div>
            </div>
        </>
    );
}
