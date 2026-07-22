import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
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

// Стартовый вид, пока нет ни одной точки с координатами.
const DEFAULT_CENTER: [number, number] = [37.618, 55.751];
const SRC = 'journal-detections';

// В источнике лежат только точки, поэтому координаты достаём напрямую —
// разбирать полный union Geometry здесь незачем.
function coordsOf(geometry: unknown): [number, number] {
  return (geometry as { coordinates: [number, number] }).coordinates;
}

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

function toGeoJson(dets: JournalDetection[], resolve: Props['resolve']) {
  return {
    type: 'FeatureCollection' as const,
    features: dets
      .filter((d) => d.gps)
      .map((d) => ({
        type: 'Feature' as const,
        id: d.id,
        geometry: { type: 'Point' as const, coordinates: [d.gps!.lon, d.gps!.lat] },
        properties: {
          id: d.id,
          color: markerColor(d, resolve),
          ts: d.ts,
          camera: d.camera_id,
          names: [...new Set(d.objects.map((o) => resolve(d.config_id, o.cid).name || '—'))].join(', '),
        },
      })),
  };
}

export function JournalMap({ detections, selectedId, mode, resolve, onSelect }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  // Инициализация карты один раз. Стиль отдаётся со своего origin вместе с
  // глифами — карта полностью офлайн.
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: boxRef.current,
      style: journalApi.styleUrl(),
      center: DEFAULT_CENTER,
      zoom: 4,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // Атрибуция OpenStreetMap обязательна по условиям лицензии ODbL.
    map.addControl(new maplibregl.AttributionControl({ customAttribution: '© OpenStreetMap' }));

    map.on('load', () => {
      map.addSource(SRC, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: 44,
        clusterMaxZoom: 15,
      });

      // Скопления снимков в одной точке сворачиваются в кластер «+N».
      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: SRC,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#4d8bff',
          'circle-opacity': 0.9,
          'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 50, 26],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#0a0c11',
        },
      });
      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: SRC,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
        },
        paint: { 'text-color': '#0a0c11' },
      });

      // Одиночные точки — цветом класса обнаружения.
      map.addLayer({
        id: 'points',
        type: 'circle',
        source: SRC,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 7,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#0a0c11',
        },
      });
      // Подсветка выбранной записи.
      map.addLayer({
        id: 'points-selected',
        type: 'circle',
        source: SRC,
        filter: ['==', ['get', 'id'], -1],
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 11,
          'circle-stroke-width': 3,
          'circle-stroke-color': '#4d8bff',
        },
      });

      map.on('click', 'points', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = Number(f.properties?.id);
        onSelect(id);
        const coords = coordsOf(f.geometry);
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ closeButton: false, maxWidth: '280px' })
          .setLngLat(coords)
          .setHTML(
            `<div class="jr-pop">` +
              `<img class="jr-pop-img" src="${journalApi.frameUrl(id)}" alt=""/>` +
              `<div class="jr-pop-meta">` +
              `<span class="jr-pop-t">${escapeHtml(fmtTime(Number(f.properties?.ts)))} · ${escapeHtml(String(f.properties?.camera ?? ''))}</span>` +
              `<span class="jr-pop-o">${escapeHtml(String(f.properties?.names ?? ''))}</span>` +
              `</div></div>`,
          )
          .addTo(map);
      });

      // Клик по кластеру — раскрываем его приближением.
      map.on('click', 'clusters', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const src = map.getSource(SRC) as maplibregl.GeoJSONSource;
        src.getClusterExpansionZoom(Number(f.properties?.cluster_id)).then((zoom) => {
          map.easeTo({ center: coordsOf(f.geometry), zoom });
        });
      });

      for (const layer of ['points', 'clusters']) {
        map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
      }

      readyRef.current = true;
      map.resize();
    });

    mapRef.current = map;
    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, [onSelect]);

  // Обновление данных и позиционирования.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;

      const data = toGeoJson(detections, resolve);
      src.setData(data);

      if (map.getLayer('points-selected')) {
        map.setFilter('points-selected', ['==', ['get', 'id'], selectedId ?? -1]);
      }

      if (!data.features.length) return;

      if (mode === 'single') {
        const sel =
          data.features.find((f) => f.properties.id === selectedId) ?? data.features[0];
        map.easeTo({ center: sel.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), 13) });
      } else {
        const bounds = new maplibregl.LngLatBounds();
        for (const f of data.features) bounds.extend(f.geometry.coordinates as [number, number]);
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 400 });
      }
    };

    if (readyRef.current) apply();
    else map.once('load', apply);
  }, [detections, selectedId, mode, resolve]);

  // Контейнер мог изменить размер (разворот на весь экран) — пересчитать.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = setTimeout(() => map.resize(), 0);
    return () => clearTimeout(t);
  }, [mode]);

  return <div className="jr-map" ref={boxRef} />;
}
