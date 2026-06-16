/**
 * PlayerFactory.tsx
 *
 * Возвращает нужный плеер в зависимости от типа камеры:
 *   type === 2  →  NeuralWebRTCPlayer  (с canvas детекций)
 *   иначе       →  WebRTCPlayer        (обычный)
 *
 * Использование:
 *   import { PlayerFactory } from './PlayerFactory';
 *
 *   <PlayerFactory
 *     cameraType={getCameraType(cameraId)}
 *     cameraId={cameraId}
 *     cameraName={getCameraDisplayName(cameraId)}
 *     signalingUrl={wsUrl(`/signaling/client/${cameraId}`)}
 *     onError={(e) => console.error(e)}
 *   />
 */

import React from 'react';
import WebRTCPlayer from './WebRTCPlayer';
import NeuralWebRTCPlayer from './NeuralWebRTCPlayer';

interface PlayerFactoryProps {
  cameraType:   number;
  cameraId:     string;
  cameraName?:  string;
  signalingUrl: string;
  onError?:     (error: string) => void;
}

const NEURAL_CAMERA_TYPE = 2;

export const PlayerFactory: React.FC<PlayerFactoryProps> = ({
  cameraType,
  cameraId,
  cameraName,
  signalingUrl,
  onError,
}) => {
  if (cameraType === NEURAL_CAMERA_TYPE) {
    return (
      <NeuralWebRTCPlayer
        key={`neural-${cameraId}`}
        cameraId={cameraId}
        cameraName={cameraName}
        signalingUrl={signalingUrl}
        onError={onError}
      />
    );
  }

  return (
    <WebRTCPlayer
      key={`player-${cameraId}`}
      cameraId={cameraId}
      cameraName={cameraName}
      signalingUrl={signalingUrl}
      onError={onError}
    />
  );
};

/**
 * Хелпер: извлечь тип камеры из списка.
 * Использовать в Observation.tsx и KioskView.tsx.
 *
 * const getCameraType = makeCameraTypeGetter(cameras);
 * const type = getCameraType('camera_3');  // → 1 | 2 | 3
 */
export function makeCameraTypeGetter(cameras: Array<{ id: string; type?: number }>) {
  return (cameraId: string): number => {
    const cam = cameras.find(c => c.id === cameraId);
    return cam?.type ?? 1;
  };
}