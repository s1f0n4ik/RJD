import { memo, type CSSProperties } from 'react';
import type { JournalDetection, JournalZone } from '../../api/journal-types';
import type { ClassMeaning, ZoneColor } from './useClassResolver';
import { VERDICT_CLASS, VERDICT_LABEL } from './Filters';
import { fmtCoord, fmtTime, reasonTag } from './format';

type Resolve = (configId: string | null, cid: number) => ClassMeaning;

interface Props {
  det: JournalDetection;
  selected: boolean;
  resolve: Resolve;
  zoneColor: ZoneColor;
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
    color: m?.color || m?.superColor || '#68a5ff',
    superName: m?.superName || det.superclass || '',
  };
}

// Название зоны из журнала; пустое — по id
export function zoneLabel(zone: JournalZone): string {
  return zone.name || `Зона ${zone.id}`;
}

// Плашка зоны её цветом
export function ZoneTag({ zone, color }: { zone: JournalZone; color: string }) {
  return (
    <span className="zone-tag" style={{ '--z': color } as CSSProperties}>
      <i className="zone-g" />
      {zoneLabel(zone)}
    </span>
  );
}

// Класс с числом треков, зона при переданном zoneColor, метки опоздания и причины закрытия
export function DetTags({ det, resolve, zoneColor }: { det: JournalDetection; resolve: Resolve; zoneColor?: ZoneColor }) {
  const c = detClass(det, resolve);
  const reason = reasonTag(det.closed_reason);
  return (
    <>
      <span className="otag">
        <i className="sw-col" style={{ background: c.color }} />
        {c.name}
        {det.tracks > 1 && <span className="num">×{det.tracks} тр.</span>}
      </span>
      {zoneColor && det.zone && <ZoneTag zone={det.zone} color={zoneColor(det.config_id, det.zone.id)} />}
      {det.late && <span className="tag is-warn">опоздало</span>}
      {reason && <span className="tag">{reason}</span>}
    </>
  );
}

function DetectionRowInner({ det, selected, resolve, zoneColor, cameraName, onSelect }: Props) {
  const vd = VERDICT_CLASS[det.verdict];

  return (
    <button type="button" className={`j-row${selected ? ' is-sel' : ''}`} onClick={() => onSelect(det.id)}>
      <span className="j-ts">{fmtTime(det.started_at)}</span>
      <span className="j-cam">{cameraName(det.camera_id)}</span>
      <span className="j-obj">
        <DetTags det={det} resolve={resolve} zoneColor={zoneColor} />
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
