import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { journalApi } from '../../api/journal';
import type { JournalDetection } from '../../api/journal-types';
import type { ClassMeaning } from './useClassResolver';
import { Icon } from '../../../../app/Icons';
import { FrameWithBoxes, previewShot } from './FrameWithBoxes';
import { DetTags, detClass } from './DetectionRow';
import { fmtDateTime, fmtTime, pluralRecords } from './format';
import { MapScene, PointsLayer, mapColor, type DrawItem, type MapPoint } from './mapPoints';

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
// Плашки только на крупном масштабе, где скоплений уже нет
const PLATE_ZOOM = 16;
// Подъём попапа над выбранной точкой: её кольцо и зазор
const POINT_LIFT = 31;
// Точка мини-карты панели меньше полноэкранной
const MINI_SIZE = 0.75;

// Попап на карте: одна запись либо список записей кластера.
interface PopupState {
  lngLat: [number, number];
  ids: number[];
  view: 'list' | 'record';
  recordId: number | null;
  lift: number;
}

interface Plate {
  id: number;
  side: 'r' | 'l';
}

function toPoints(dets: JournalDetection[], resolve: Props['resolve']): MapPoint[] {
  return dets
    .filter((d) => d.gps)
    .map((d) => {
      const c = detClass(d, resolve);
      return {
        id: d.id,
        lng: d.gps!.lon,
        lat: d.gps!.lat,
        ts: d.started_at,
        color: mapColor(c.color),
        name: c.name,
        time: fmtTime(d.started_at).slice(0, 5),
        verdict: d.verdict,
      };
    });
}

const measure = document.createElement('canvas').getContext('2d')!;
const textW = (s: string, font: string) => {
  measure.font = font;
  return measure.measureText(s).width;
};

// Плашка справа от точки, при столкновении слева, иначе без плашки; выбранная раскладывается первой
function layoutPlates(map: maplibregl.Map, items: DrawItem[], selected: number | null): Plate[] {
  const points = items
    .filter((it) => it.point && it.alpha > 0.5)
    .map((it) => ({ p: it.point!, at: map.project([it.point!.lng, it.point!.lat]) }));
  const taken = points.map(({ at }) => ({ x: at.x - 16, y: at.y - 16, w: 32, h: 32 }));
  const hits = (a: (typeof taken)[number]) =>
    taken.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  const out: Plate[] = [];
  points
    .sort((a, b) => Number(b.p.id === selected) - Number(a.p.id === selected))
    .forEach(({ p, at }) => {
      const w = Math.ceil((textW(p.name, '11.5px Inter') + textW(p.time, '10.5px "JetBrains Mono"') + 43) * 1.07);
      const h = 24;
      const side = ([['r', at.x + 26], ['l', at.x - 26 - w]] as const).find(([, x]) => !hits({ x, y: at.y - h / 2, w, h }));
      if (!side) return;
      taken.push({ x: side[1] - 3, y: at.y - h / 2 - 3, w: w + 6, h: h + 6 });
      out.push({ id: p.id, side: side[0] });
    });
  return out;
}

const VERDICT_ICON: Record<string, ReactNode> = {
  true: (
    <svg width="9" height="9" viewBox="0 0 10 10">
      <path d="M1.6 5.3l2.3 2.3 4.6-5" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  false: (
    <svg width="7.5" height="7.5" viewBox="0 0 10 10">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

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
  const platesRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const readyRef = useRef(false);
  // Набор точек, под который камера уже подстраивалась.
  const fitKeyRef = useRef('');

  const [plates, setPlates] = useState<Plate[]>([]);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const popupObjRef = useRef<maplibregl.Popup | null>(null);
  // Контейнер живёт дольше попапа: в него порталом рендерится содержимое.
  const popupBoxRef = useRef<HTMLDivElement | null>(null);
  if (!popupBoxRef.current) popupBoxRef.current = document.createElement('div');

  // Обработчики карты живут весь срок карты — колбэки читаем через ref.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // Попапы и плашки только на полном экране: на мини-карте панели им негде поместиться
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const followRef = useRef<() => void>(() => {});
  const hoverRef = useRef<(key: string | null) => void>(() => {});
  const openRef = useRef<(item: DrawItem) => void>(() => {});

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
      // Пути в style.json относительные — делаем абсолютными для воркера
      transformRequest: (url) =>
        url.startsWith('/api/journal/') ? { url: journalApi.resourceUrl(url) } : undefined,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // Атрибуция OpenStreetMap обязательна по условиям лицензии ODbL.
    map.addControl(new maplibregl.AttributionControl({ customAttribution: '© OpenStreetMap' }));

    const scene = new MapScene(map);
    scene.instant = modeRef.current === 'single';
    scene.size = modeRef.current === 'single' ? MINI_SIZE : 1;
    sceneRef.current = scene;

    // Плашки следуют за своими точками каждый кадр
    followRef.current = () => {
      const box = platesRef.current;
      if (!box) return;
      const at = new Map(scene.items.filter((it) => it.point).map((it) => [it.point!.id, it]));
      for (const el of Array.from(box.children) as HTMLElement[]) {
        const it = at.get(Number(el.dataset.id));
        el.style.transform = it ? `translate(${it.x}px, ${it.y}px)` : 'translate(-9999px, -9999px)';
        el.style.opacity = it ? String(it.alpha) : '0';
      }
    };

    hoverRef.current = (key) => {
      if (scene.hover === key) return;
      scene.hover = key;
      map.getCanvas().style.cursor = key ? 'pointer' : '';
      for (const el of Array.from(platesRef.current?.children ?? []) as HTMLElement[]) {
        if (`p:${el.dataset.id}` === key) el.dataset.hover = '';
        else delete el.dataset.hover;
      }
      map.triggerRepaint();
    };

    const replace = () =>
      setPlates(
        modeRef.current === 'full' && map.getZoom() >= PLATE_ZOOM ? layoutPlates(map, scene.items, scene.selected) : [],
      );

    map.on('load', () => {
      map.addLayer(new PointsLayer(scene, () => followRef.current()));
      readyRef.current = true;
      map.resize();
    });
    map.on('zoomstart', () => setPlates([]));
    map.on('moveend', () => map.once('render', replace));
    map.on('mousemove', (e) => hoverRef.current(scene.hit(e.point.x, e.point.y)?.key ?? null));
    map.on('mouseout', () => hoverRef.current(null));
    // Клик мимо точек и кластеров закрывает попап; closeOnClick у попапа выключен,
    // иначе клик по соседней точке закрыл бы только что открытый попап.
    map.on('click', (e) => {
      const it = scene.hit(e.point.x, e.point.y);
      if (it) openRef.current(it);
      else setPopup(null);
    });

    mapRef.current = map;
    return () => {
      popupObjRef.current?.remove();
      popupObjRef.current = null;
      map.remove();
      mapRef.current = null;
      sceneRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // Точка — выбор и попап записи; скопление — попап со списком, новые сверху
  openRef.current = (it) => {
    if (it.point) {
      onSelectRef.current(it.point.id);
      if (modeRef.current !== 'full') return;
      setPopup({ lngLat: [it.point.lng, it.point.lat], ids: [it.point.id], view: 'record', recordId: it.point.id, lift: POINT_LIFT });
      return;
    }
    const scene = sceneRef.current;
    const map = mapRef.current;
    if (!scene || !map || modeRef.current !== 'full' || !it.cluster) return;
    const at = map.unproject([it.x, it.y]);
    setPopup({
      lngLat: [at.lng, at.lat],
      ids: scene.leavesOf(it.cluster.id),
      view: 'list',
      recordId: null,
      lift: it.cluster.r0 * it.scale + 4,
    });
  };

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
    popupObjRef.current.setOffset(popup.lift).setLngLat(popup.lngLat);
    if (!popupObjRef.current.isOpen()) popupObjRef.current.addTo(map);
  }, [popup]);

  // Смена режима — камера подстраивается заново, один раз.
  useEffect(() => {
    fitKeyRef.current = '';
    setPopup(null);
    if (sceneRef.current) {
      sceneRef.current.instant = mode === 'single';
      sceneRef.current.size = mode === 'single' ? MINI_SIZE : 1;
      mapRef.current?.triggerRepaint();
    }
  }, [mode]);

  // Выбор меняет только вид точки: кольцо и масштаб доигрывают переходы
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.selected = selectedId;
    mapRef.current?.triggerRepaint();
  }, [selectedId]);

  // Новые плашки встают на свои точки до отрисовки
  useLayoutEffect(() => followRef.current(), [plates]);

  // Обновление данных и позиционирования.
  useEffect(() => {
    const map = mapRef.current;
    const scene = sceneRef.current;
    if (!map || !scene) return;

    const apply = () => {
      const points = toPoints(detections, resolve);
      scene.selected = selectedId;
      scene.setData(points);
      map.triggerRepaint();
      map.once('render', () =>
        setPlates(modeRef.current === 'full' && map.getZoom() >= PLATE_ZOOM ? layoutPlates(map, scene.items, scene.selected) : []),
      );

      if (!points.length) return;

      // Смена одного лишь выбора (клик по точке, запись из попапа кластера)
      // камеру не трогает — перецентровка только при изменении набора точек.
      const key = points.map((p) => p.id).join(',');
      if (key === fitKeyRef.current) return;
      const first = fitKeyRef.current === '';
      fitKeyRef.current = key;

      // На полном экране границы подгоняются только при входе: новая запись
      // из опроса не должна сбивать зум, который выставил человек
      if (mode === 'full' && !first) return;

      if (mode === 'single') {
        const sel = points.find((p) => p.id === selectedId) ?? points[0];
        map.easeTo({ center: [sel.lng, sel.lat], zoom: Math.max(map.getZoom(), 13) });
      } else {
        const bounds = new maplibregl.LngLatBounds();
        for (const p of points) bounds.extend([p.lng, p.lat]);
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 400 });
      }
    };

    if (readyRef.current) apply();
    else map.once('load', apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detections, mode, resolve]);

  // Контейнер мог изменить размер (разворот на весь экран) — пересчитать.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = setTimeout(() => map.resize(), 0);
    return () => clearTimeout(t);
  }, [mode]);

  const byId = (id: number) => detections.find((d) => d.id === id);
  const frameLabel = (d: JournalDetection) => {
    const c = detClass(d, resolve);
    return { color: c.color, name: c.name };
  };

  const openRecord = (id: number) => {
    onSelect(id);
    setPopup((p) => (p ? { ...p, view: 'record', recordId: id } : p));
  };

  let content: ReactNode = null;
  if (popup?.view === 'record') {
    const det = popup.recordId != null ? byId(popup.recordId) : undefined;
    content = (
      <div className="jm-pop jm-pop-rec">
        <div className="jm-pop-head">
          {popup.ids.length > 1 && (
            <button
              className="icon-btn jm-pop-btn"
              data-tip="К списку"
              onClick={() => setPopup({ ...popup, view: 'list', recordId: null })}
            >
              <Icon name="chev" size={12} className="ico is-back" />
            </button>
          )}
          {det && <span className="j-ts">{fmtDateTime(det.started_at)}</span>}
          {det && <span className="jm-pop-cam">{cameraName(det.camera_id)}</span>}
          <button className="icon-btn jm-pop-btn jm-pop-close" data-tip="Закрыть" onClick={() => setPopup(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
        {det ? (
          <>
            <div className="j-obj">
              <DetTags det={det} resolve={resolve} />
            </div>
            <button className="jm-pop-thumb" data-tip="Открыть кадр" onClick={() => onOpenViewer(det.id)}>
              <FrameWithBoxes shot={previewShot(det)} {...frameLabel(det)} className="jm-pop-frame" />
            </button>
          </>
        ) : (
          <span className="jm-pop-gone">Запись больше не в загруженном списке</span>
        )}
      </div>
    );
  } else if (popup?.view === 'list') {
    const dets = popup.ids.map(byId).filter((d): d is JournalDetection => !!d);
    content = (
      <div className="jm-pop jm-pop-list">
        <div className="jm-pop-head">
          <span className="eyebrow">{pluralRecords(dets.length)}</span>
          <button className="icon-btn jm-pop-btn jm-pop-close" data-tip="Закрыть" onClick={() => setPopup(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="jm-pop-scroll">
          {dets.map((d) => (
            <button key={d.id} className="jm-pop-row" onClick={() => openRecord(d.id)}>
              <span
                className="jm-pop-mini-btn"
                data-tip="Открыть кадр"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenViewer(d.id);
                }}
              >
                <FrameWithBoxes shot={previewShot(d)} {...frameLabel(d)} compact className="jm-pop-mini" />
              </span>
              <span className="jm-pop-row-info">
                <span className="j-ts">{fmtDateTime(d.started_at)}</span>
                <span className="jm-pop-cam">{cameraName(d.camera_id)}</span>
                <span className="j-obj">
                  <DetTags det={d} resolve={resolve} />
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const scene = sceneRef.current;
  return (
    <div className="jm-wrap">
      <div className="jm-map" ref={boxRef} />
      <div className="jm-plates" ref={platesRef}>
        {plates.map((pl) => {
          const p = scene?.points.get(pl.id);
          if (!p) return null;
          return (
            <button
              key={pl.id}
              type="button"
              data-id={pl.id}
              className={`jm-plate side-${pl.side}${pl.id === selectedId ? ' is-sel' : ''}`}
              aria-label={`${p.name}, ${p.time}`}
              onMouseEnter={() => hoverRef.current(`p:${pl.id}`)}
              onMouseLeave={() => hoverRef.current(null)}
              onClick={() => {
                const it = scene?.items.find((d) => d.point?.id === pl.id);
                if (it) openRef.current(it);
              }}
            >
              <span className="jm-plate-in">
                {VERDICT_ICON[p.verdict] && <span className={`jm-vd v-${p.verdict}`}>{VERDICT_ICON[p.verdict]}</span>}
                <i style={{ background: p.color }} />
                <span className="n">{p.name}</span>
                <span className="t">{p.time}</span>
              </span>
            </button>
          );
        })}
      </div>
      {createPortal(content, popupBoxRef.current)}
    </div>
  );
}
