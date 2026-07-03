import type { CameraMatrix, CoreId } from '../../api/types';
import type { CamOption } from './CoresSection';
import { CameraMatrixBuilder } from './CameraMatrixBuilder';

interface ConfigChipProps {
  configId: string;
  cameraMatrix: CameraMatrix;
  pending: boolean;
  editable: boolean;
  occupiedCores: CoreId[];
  availableCameras: CamOption[];
  excludedCameras: Set<string>;
  onCamerasChange: (matrix: CameraMatrix) => void;
  onRemove: () => void;
  onDragStart: () => void;
}

export function ConfigChip({
  configId,
  cameraMatrix,
  pending,
  editable,
  occupiedCores,
  availableCameras,
  excludedCameras,
  onCamerasChange,
  onRemove,
  onDragStart,
}: ConfigChipProps) {
  const stateClass = pending ? 'pending' : 'loaded';
  const isCopied = occupiedCores.length > 1;

  return (
    <div
      className={`chip chip-${stateClass}`}
      draggable={editable}
      onDragStart={(e) => {
        if (!editable) return;
        e.dataTransfer.setData('application/x-config', configId);
        e.dataTransfer.effectAllowed = 'copyMove';
        onDragStart();
      }}
    >
      <div className="chip-head">
        <span className="chip-name">{configId}</span>
        {isCopied && (
          <span className="chip-cores" title="Конфигурация занимает несколько ядер">
            ядра {occupiedCores.join(', ')}
          </span>
        )}
        {editable && (
          <button className="btn btn-danger btn-sm" title="Снять с ядра" onClick={onRemove}>
            ×
          </button>
        )}
      </div>

      <div className="chip-section-label">Матрица камер</div>
      <CameraMatrixBuilder
        matrix={cameraMatrix}
        cameras={availableCameras}
        excluded={excludedCameras}
        editable={editable}
        onChange={onCamerasChange}
      />
    </div>
  );
}
