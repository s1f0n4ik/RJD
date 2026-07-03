import { useState } from 'react';
import type { DragEvent } from 'react';
import type { CameraMatrix, CoreId } from '../../api/types';
import type { CamOption } from './CoresSection';
import { ConfigChip } from './ConfigChip';

type DropMode = 'move' | 'copy';
type DragKind = 'core' | 'list' | null;

interface CoreCardProps {
  coreId: CoreId;
  configId: string | null;
  pending: boolean;
  cameraMatrix: CameraMatrix;
  availableCameras: CamOption[];
  excludedCameras: Set<string>;
  occupiedCores: CoreId[];
  running: boolean;
  editable: boolean;
  dragging: boolean;
  dragKind: DragKind;
  onDropConfig: (coreId: CoreId, configId: string, mode: DropMode) => void;
  onCamerasChange: (coreId: CoreId, matrix: CameraMatrix) => void;
  onRemove: (coreId: CoreId) => void;
  onDragStart: (configId: string, sourceCoreId: CoreId) => void;
  onExpandAll: (coreId: CoreId) => void;
}

export function CoreCard({
  coreId,
  configId,
  pending,
  cameraMatrix,
  availableCameras,
  excludedCameras,
  occupiedCores,
  running,
  editable,
  dragging,
  dragKind,
  onDropConfig,
  onCamerasChange,
  onRemove,
  onDragStart,
  onExpandAll,
}: CoreCardProps) {
  const [overZone, setOverZone] = useState<DropMode | null>(null);

  const occupied = configId !== null;

  let cardCls = 'core-card';
  if (pending) cardCls += ' core-card-pending';
  else if (occupied && running) cardCls += ' core-card-active';
  else if (occupied) cardCls += ' core-card-loaded';

  const stateText = pending
    ? occupied
      ? 'ожидает применения'
      : 'будет очищено'
    : occupied
      ? running
        ? 'ACTIVE'
        : 'LOADED'
      : 'IDLE';

  const stateColorCls = pending ? 'warn' : occupied && running ? 'on' : 'off';

  function handleDrop(mode: DropMode, e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOverZone(null);
    const dropped = e.dataTransfer.getData('application/x-config');
    onDropConfig(coreId, dropped, mode);
  }

  function zoneProps(mode: DropMode) {
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = mode === 'copy' ? 'copy' : 'move';
        setOverZone(mode);
      },
      onDragLeave: () => setOverZone((z) => (z === mode ? null : z)),
      onDrop: (e: DragEvent) => handleDrop(mode, e),
    };
  }

  const showDropZones = editable && dragging;
  const moveOnly = dragKind === 'list';

  return (
    <div className="core-row-wrap">
      <div className={cardCls}>
        <div className="core-head">
          <span className="core-id">CORE {coreId}</span>
          <span className={`core-state ${stateColorCls}`}>
            <span className="state-dot" />
            {stateText}
          </span>
        </div>

        {occupied ? (
          <>
            <ConfigChip
              configId={configId}
              cameraMatrix={cameraMatrix}
              pending={pending}
              editable={editable}
              occupiedCores={occupiedCores}
              availableCameras={availableCameras}
              excludedCameras={excludedCameras}
              onCamerasChange={(m) => onCamerasChange(coreId, m)}
              onRemove={() => onRemove(coreId)}
              onDragStart={() => onDragStart(configId, coreId)}
            />
            {editable && occupiedCores.length < 3 && (
              <button
                className="core-expand-all"
                onClick={() => onExpandAll(coreId)}
                title="Задействовать все ядра для этого слота"
              >
                Ко всем ядрам
              </button>
            )}
          </>
        ) : editable ? (
          <div className="core-empty">
            {pending ? 'будет очищено при применении' : 'перетащите конфигурацию сюда'}
          </div>
        ) : (
          <div className="core-empty-text">отсутствует конфигурация для данного ядра</div>
        )}

        {/* Зоны перемещения / копирования — поверх карточки во время перетаскивания */}
        {showDropZones &&
          (moveOnly ? (
            <div className="core-dropzones">
              <div className={`core-dz core-dz-move full${overZone === 'move' ? ' over' : ''}`} {...zoneProps('move')}>
                <span>Переместить</span>
              </div>
            </div>
          ) : (
            <div className="core-dropzones">
              <div className={`core-dz core-dz-move${overZone === 'move' ? ' over' : ''}`} {...zoneProps('move')}>
                <span>Переместить</span>
              </div>
              <div className={`core-dz core-dz-copy${overZone === 'copy' ? ' over' : ''}`} {...zoneProps('copy')}>
                <span>Копировать</span>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
