import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { journalApi } from '../../api/journal';
import type { JournalDetection } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { fmtTime } from './format';

interface Props {
  detections: JournalDetection[];
  selectedId: number | null;
  mode: 'single' | 'full';
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  onSelect: (id: number) => void;
}

// Дорога где-то в РФ; используется только как старт, пока нет точек с GPS.
const DEFAULT_CENTER: L.LatLngExpression = [55.751, 37.618];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

// Цвет точки — по суперклассу самого «уверенного» объекта кадра.
function markerColor(det: JournalDetection, resolve: Props['resolve']): string {
  let best = det.objects[0];
  for (const o of det.objects) if (!best || o.cf > best.cf) best = o;
  if (!best) return '#4d8bff';
  const m = resolve(det.config_id, best.cid);
  return m.superColor || m.color || '#4d8bff';
}

function pinIcon(color: string, selected: boolean): L.DivIcon {
  return L.divIcon({
    className: 'jr-pin-wrap',
    html: `<span class="jr-pin${selected ? ' sel' : ''}" style="background:${color}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 16],
    popupAnchor: [0, -16],
  });
}

function popupHtml(det: JournalDetection, resolve: Props['resolve']): string {
  const names = [...new Set(det.objects.map((o) => resolve(det.config_id, o.cid).name || '—'))].join(', ');
  return (
    `<div class="jr-pop">` +
    `<img class="jr-pop-img" src="${journalApi.frameUrl(det.id)}" alt=""/>` +
    `<div class="jr-pop-meta">` +
    `<span class="jr-pop-t">${escapeHtml(fmtTime(det.ts))} · ${escapeHtml(det.camera_id)}</span>` +
    `<span class="jr-pop-o">${escapeHtml(names)}</span>` +
    `</div></div>`
  );
}

export function JournalMap({ detections, selectedId, mode, resolve, onSelect }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  // Инициализация карты один раз.
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, {
      center: DEFAULT_CENTER,
      zoom: 12,
      zoomControl: true,
      attributionControl: false,
    });
    L.tileLayer(journalApi.tileTemplate(), { maxZoom: 19, minZoom: 3 }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Пересборка маркеров при смене данных/режима/выбора.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (layerRef.current) {
      layerRef.current.remove();
      layerRef.current = null;
    }

    const withGps = detections.filter((d) => d.gps);

    // Полноэкранный режим — все точки с кластеризацией; иначе одиночные маркеры.
    const layer: L.LayerGroup =
      mode === 'full'
        ? (L as any).markerClusterGroup({ maxClusterRadius: 44, showCoverageOnHover: false })
        : L.layerGroup();

    for (const det of withGps) {
      const gps = det.gps!;
      const marker = L.marker([gps.lat, gps.lon], {
        icon: pinIcon(markerColor(det, resolve), det.id === selectedId),
      });
      marker.bindPopup(popupHtml(det, resolve), { minWidth: 220 });
      marker.on('click', () => onSelect(det.id));
      layer.addLayer(marker);
    }

    layer.addTo(map);
    layerRef.current = layer;

    // Позиционирование: single — центр на выбранной; full — по всем точкам.
    if (mode === 'single') {
      const sel = withGps.find((d) => d.id === selectedId) ?? withGps[0];
      if (sel?.gps) map.setView([sel.gps.lat, sel.gps.lon], Math.max(map.getZoom(), 14));
    } else if (withGps.length) {
      const bounds = L.latLngBounds(withGps.map((d) => [d.gps!.lat, d.gps!.lon] as [number, number]));
      map.fitBounds(bounds.pad(0.2), { maxZoom: 16 });
    }
  }, [detections, selectedId, mode, resolve, onSelect]);

  // Карта могла быть отрисована в скрытом/изменённом контейнере — пересчитать размер.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = setTimeout(() => map.invalidateSize(), 0);
    return () => clearTimeout(t);
  }, [mode]);

  return <div className="jr-map" ref={boxRef} />;
}
