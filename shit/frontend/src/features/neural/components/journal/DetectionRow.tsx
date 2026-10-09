import { memo } from 'react';
import type { JournalDetection } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { VERDICT_CLASS, VERDICT_LABEL } from './Filters';
import { fmtCoord, fmtTime, reasonTag } from './format';

type Resolve = (configId: string | null, cid: number) => ClassMeaning;

interface Props {
  det: JournalDetection;
  selected: boolean;
  resolve: Resolve;
  cameraName: (id: string) => string;
  onSelect: (id: number) => void;
}

export interface DetClass {
  name: string;
  color: string;
  superName: string;
}

// Имя класса — из журнала, цвет и суперкласс — из конфигурации обнаружения
export function detClass(det: JournalDetection, resolve: Resolve): DetClass {
  const m = det.class_id != null ? resolve(det.config_id, det.class_id) : null;
  return {
    name: det.class_name || m?.name || '—',
    color: m?.color || m?.superColor || '#5b9dff',
    superName: m?.superName || det.superclass || '',
  };
}

// Класс с числом треков и метки опоздания и причины закрытия
export function DetTags({ det, resolve }: { det: JournalDetection; resolve: Resolve }) {
  const c = detClass(det, resolve);
  const reason = reasonTag(det.closed_reason);
  return (
    <>
      <span className="otag">
        <i className="sw-col" style={{ background: c.color }} />
        {c.name}
        {det.tracks > 1 && <span className="num">×{det.tracks} тр.</span>}
      </span>
      {det.late && <span className="tag is-warn">опоздало</span>}
      {reason && <span className="tag">{reason}</span>}
    </>
  );
}

function DetectionRowInner({ det, selected, resolve, cameraName, onSelect }: Props) {
  const vd = VERDICT_CLASS[det.verdict];

  return (
    <button type="button" className={`j-row${selected ? ' is-sel' : ''}`} onClick={() => onSelect(det.id)}>
      <span className="j-ts">{fmtTime(det.started_at)}</span>
      <span className="j-cam">{cameraName(det.camera_id)}</span>
      <span className="j-obj">
        <DetTags det={det} resolve={resolve} />
      </span>
      <span className="j-tr">{det.gps ? `${fmtCoord(det.gps.lat)}, ${fmtCoord(det.gps.lon)}` : '—'}</span>
      <span className={`vd ${vd.vd}`}>
        <span className={`dot${vd.dot ? ' ' + vd.dot : ''}`} />
        {VERDICT_LABEL[det.verdict]}
      </span>
    </button>
  );
}

// Список длинный, а опрос head меняет состояние раздела — без мемоизации перерисовывались бы все строки
export const DetectionRow = memo(DetectionRowInner);
