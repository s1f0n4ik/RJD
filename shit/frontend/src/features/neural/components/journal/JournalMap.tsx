import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { journalApi } from '../../api/journal';
import type { JournalDetection } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { FrameWithBoxes } from './FrameWithBoxes';
import { fmtDateTime, pluralRecords } from './format';

interface Props {
  detections: JournalDetection[];
  selectedId: number | null;
  mode: 'single' | 'full';
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  cameraName: (id: string) => string;
  onSelect: (id: number) => void;
  onOpenViewer: (id: number) => void;
}

// Стартовый вид, пока нет ни одной точки с координатами.
const DEFAULT_CENTER: [number, number] = [37.618, 55.751];
const SRC = 'journal-detections';
const FALLBACK = '#4d8bff';
const PIE = 'jr-pie:';

// Попап на карте: одна запись либо список записей кластера.
interface PopupState {
  lngLat: [number, number];
  ids: number[];
  view: 'list' | 'record';
  recordId: number | null;
}

// В источнике лежат только точки, поэтому координаты достаём напрямую —
// разбирать полный union Geometry здесь незачем.
function coordsOf(geometry: unknown): [number, number] {
  return (geometry as { coordinates: [number, number] }).coordinates;
}

// Классы записи со счётчиком объектов — как в строке журнала.
function aggClasses(det: JournalDetection, resolve: Props['resolve']) {
  const agg = new Map<number, ClassMeaning & { count: number }>();
  for (const o of det.objects) {
    const prev = agg.get(o.cid);
    if (prev) prev.count += 1;
    else agg.set(o.cid, { ...resolve(det.config_id, o.cid), count: 1 });
  }
  return [...agg.values()].sort((a, b) => b.count - a.count);
}

function classColor(c: ClassMeaning): string {
  return c.color || c.superColor || FALLBACK;
}

// Уникальные цвета классов записи — сектора пай-иконки, максимум 6.
function pieColors(det: JournalDetection, resolve: Props['resolve']): string[] {
  const out: string[] = [];
  for (const c of aggClasses(det, resolve)) {
    const col = classColor(c);
    if (!out.includes(col)) out.push(col);
    if (out.length === 6) break;
  }
  return out.length ? out : [FALLBACK];
}

// Иконка точки: круг из равных секторов по цветам классов, обводка под фон.
function makePieIcon(colors: string[]): { data: ImageData; pixelRatio: number } {
  const ratio = Math.min(Math.ceil(window.devicePixelRatio || 1), 3);
  const size = 20 * ratio;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const r = c - 1.5 * ratio;
  colors.forEach((color, i) => {
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(
      c,
      c,
      r,
      -Math.PI / 2 + (i / colors.length) * 2 * Math.PI,
      -Math.PI / 2 + ((i + 1) / colors.length) * 2 * Math.PI,
    );
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  });
  ctx.beginPath();
  ctx.arc(c, c, r, 0, 2 * Math.PI);
  ctx.lineWidth = 2 * ratio;
  ctx.strokeStyle = '#0a0c11';
  ctx.stroke();
  return { data: ctx.getImageData(0, 0, size, size), pixelRatio: ratio };
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
          ts: d.ts,
          icon: PIE + pieColors(d, resolve).join('|'),
        },
      })),
  };
}

export function JournalMap({
  detections,
  selectedId,
  mode,
  resolve,
  cameraName,
  onSelect,
  onOpenViewer,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  // Набор точек, под который камера уже подстраивалась.
  const fitKeyRef = useRef('');

  const [popup, setPopup] = useState<PopupState | null>(null);
  const popupObjRef = useRef<maplibregl.Popup | null>(null);
  // Контейнер живёт дольше попапа: в него порталом рендерится содержимое.
  const popupBoxRef = useRef<HTMLDivElement | null>(null);
  if (!popupBoxRef.current) popupBoxRef.current = document.createElement('div');

  // Обработчики карты живут весь срок карты — колбэки читаем через ref.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

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
      // Пути в style.json относительные — переписываем на storage-service устройства
      transformRequest: (url) =>
        url.startsWith('/api/journal/') ? { url: journalApi.resourceUrl(url) } : undefined,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // Атрибуция OpenStreetMap обязательна по условиям лицензии ODbL.
    map.addControl(new maplibregl.AttributionControl({ customAttribution: '© OpenStreetMap' }));

    // Пай-иконки создаются по требованию: имя кодирует цвета секторов.
    map.on('styleimagemissing', (e) => {
      if (!e.id.startsWith(PIE)) return;
      const { data, pixelRatio } = makePieIcon(e.id.slice(PIE.length).split('|'));
      map.addImage(e.id, data, { pixelRatio });
    });

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
          'circle-color': FALLBACK,
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

      // Ореол выбранной записи — под пай-иконкой точки.
      map.addLayer({
        id: 'points-selected',
        type: 'circle',
        source: SRC,
        filter: ['==', ['get', 'id'], -1],
        paint: {
          'circle-color': 'rgba(77,139,255,0.25)',
          'circle-radius': 13,
          'circle-stroke-width': 2,
          'circle-stroke-color': FALLBACK,
        },
      });
      // Одиночные точки — пай-иконка по цветам классов записи.
      map.addLayer({
        id: 'points',
        type: 'symbol',
        source: SRC,
        filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });

      map.on('click', 'points', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = Number(f.properties?.id);
        onSelectRef.current(id);
        setPopup({ lngLat: coordsOf(f.geometry), ids: [id], view: 'record', recordId: id });
      });

      // Клик по кластеру — список его записей, новые сверху.
      map.on('click', 'clusters', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const src = map.getSource(SRC) as maplibregl.GeoJSONSource;
        const lngLat = coordsOf(f.geometry);
        src.getClusterLeaves(Number(f.properties?.cluster_id), 10000, 0).then((leaves) => {
          const ids = leaves
            .map((l) => ({ id: Number(l.properties?.id), ts: Number(l.properties?.ts) }))
            .sort((a, b) => b.ts - a.ts)
            .map((l) => l.id);
          setPopup({ lngLat, ids, view: 'list', recordId: null });
        });
      });

      // Клик мимо точек и кластеров закрывает попап; closeOnClick выключен,
      // иначе клик по соседней точке закрыл бы только что открытый попап.
      map.on('click', (e) => {
        if (!map.getLayer('points')) return;
        const hits = map.queryRenderedFeatures(e.point, { layers: ['points', 'clusters'] });
        if (!hits.length) setPopup(null);
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
      popupObjRef.current?.remove();
      popupObjRef.current = null;
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // Позиция и видимость maplibre-попапа следуют за состоянием.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!popup) {
      popupObjRef.current?.remove();
      return;
    }
    if (!popupObjRef.current) {
      popupObjRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        maxWidth: 'none',
      }).setDOMContent(popupBoxRef.current!);
    }
    popupObjRef.current.setLngLat(popup.lngLat);
    if (!popupObjRef.current.isOpen()) popupObjRef.current.addTo(map);
  }, [popup]);

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

      // Смена одного лишь выбора (клик по точке, запись из попапа кластера)
      // камеру не трогает — перецентровка только при изменении набора точек.
      const key = data.features.map((f) => f.properties.id).join(',');
      if (key === fitKeyRef.current) return;
      fitKeyRef.current = key;

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

  const byId = (id: number) => detections.find((d) => d.id === id);

  const openRecord = (id: number) => {
    onSelect(id);
    setPopup((p) => (p ? { ...p, view: 'record', recordId: id } : p));
  };

  let content: ReactNode = null;
  if (popup?.view === 'record') {
    const det = popup.recordId != null ? byId(popup.recordId) : undefined;
    content = (
      <div className="jr-mpop jr-mpop-rec">
        <div className="jr-mpop-head">
          {popup.ids.length > 1 && (
            <button
              className="jr-mini"
              title="К списку кластера"
              onClick={() => setPopup({ ...popup, view: 'list', recordId: null })}
            >
              ←
            </button>
          )}
          {det && <span className="jr-time">{fmtDateTime(det.ts)}</span>}
          {det && <span className="jr-mpop-cam">{cameraName(det.camera_id)}</span>}
          <button className="jr-mini jr-mpop-close" title="Закрыть" onClick={() => setPopup(null)}>
            ✕
          </button>
        </div>
        {det ? (
          <>
            <div className="jr-chips">
              {aggClasses(det, resolve).map((c, i) => (
                <span className="jr-chip" key={i}>
                  <span className="jr-cd" style={{ background: classColor(c) }} />
                  {c.name || '—'}
                  <span className="jr-chip-n">×{c.count}</span>
                </span>
              ))}
            </div>
            <button className="jr-thumb-btn" title="Открыть кадр" onClick={() => onOpenViewer(det.id)}>
              <FrameWithBoxes det={det} resolve={resolve} className="jr-mpop-frame" />
            </button>
          </>
        ) : (
          <span className="jr-mpop-gone">Запись больше не в загруженном списке</span>
        )}
      </div>
    );
  } else if (popup?.view === 'list') {
    const dets = popup.ids.map(byId).filter((d): d is JournalDetection => !!d);
    content = (
      <div className="jr-mpop jr-mpop-list">
        <div className="jr-mpop-head">
          <span className="jr-sect-lbl">{pluralRecords(dets.length)}</span>
          <button className="jr-mini jr-mpop-close" title="Закрыть" onClick={() => setPopup(null)}>
            ✕
          </button>
        </div>
        <div className="jr-mpop-scroll">
          {dets.map((d) => (
            <button key={d.id} className="jr-mpop-row" onClick={() => openRecord(d.id)}>
              <span
                className="jr-mpop-mini-btn"
                title="Открыть кадр"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenViewer(d.id);
                }}
              >
                <FrameWithBoxes det={d} resolve={resolve} compact className="jr-mpop-mini" />
              </span>
              <span className="jr-mpop-row-info">
                <span className="jr-time">{fmtDateTime(d.ts)}</span>
                <span className="jr-mpop-cam">{cameraName(d.camera_id)}</span>
                <span className="jr-chips">
                  {aggClasses(d, resolve)
                    .slice(0, 3)
                    .map((c, i) => (
                      <span className="jr-chip" key={i}>
                        <span className="jr-cd" style={{ background: classColor(c) }} />
                        {c.name || '—'}
                      </span>
                    ))}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="jr-map" ref={boxRef} />
      {createPortal(content, popupBoxRef.current)}
    </>
  );
}
