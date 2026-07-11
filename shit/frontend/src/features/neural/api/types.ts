// ─────────────────────────────────────────────────────────────
//  Типы, повторяющие контракт C++ сервера (neural-controller.cpp).
// ─────────────────────────────────────────────────────────────

/** Краткая запись из GET /neural/configurations */
export interface ConfigSummary {
  id: string;
  name: string;
}

export interface ThresholdConfig {
  nms: number;
  confidence: number;
}

export interface SuperclassDef {
  name: string;
  color: string;
}

export interface ClassDef {
  name: string;
  server_id: string;
  superclass: string;
  color: string;
}

/** Конфиг трекера (в терминологии UI — «фильтр»). json-configurator читает type "iou". */
export interface TrackerConfig {
  type: string;
  iou_threshold: number;
  min_hits: number;
  max_lost: number;
  move_threshold: number;
}

/** Реализованный тип трекера (GET /neural/tracker-types). */
export interface TrackerType {
  type: string;
  name: string;
}

/** Тип события трека (GET /neural/event-types) — только идентификатор.
 *  Человекочитаемые названия задаёт фронт (бэкенд отдаёт лишь id). */
export interface TrackEventType {
  type: string;
}

/** Полный JSON конфигурации (GET /neural/configurations?id=...) */
export interface NeuralConfig {
  name: string;
  model_path: string;
  model_width: number;
  model_height: number;
  /** Ограничение частоты обработки кадров нейронкой (FConfigInfo.fps). */
  fps?: number;
  thresholds: ThresholdConfig;
  /** Трекер / «фильтр»: наличие валидного объекта = включён, null/отсутствие = выключен. */
  tracker?: TrackerConfig | null;
  superclasses: Record<string, SuperclassDef>;
  classes: Record<string, ClassDef>;
}

/** Матрица камер: строки → камеры */
export type CameraMatrix = string[][];

// ── Богатая раскладка камер потока ────────────────────────────
// Фронт редактирует сетку ячейками (regions), бэкенд переводит их в
// нормализованные тайлы rect=[x,y,w,h] в долях кадра [0..1].

/** Ячейка сетки-редактора (что отправляет фронт при mode='grid'). */
export interface CameraRegion {
  row: number;
  col: number;
  row_span: number;
  col_span: number;
  camera: string;
}

/** Нормализованный тайл камеры (что возвращает бэкенд для рендера). */
export interface CameraTile {
  camera: string;
  /** [x, y, w, h] — доли кадра [0..1] */
  rect: [number, number, number, number];
}

/** Раскладка камер потока. Сейчас конвейер обрабатывает только single. */
export interface CameraLayout {
  mode: 'single' | 'grid';
  rows: number;
  cols: number;
  /** mode='single' */
  single?: string;
  /** отдаётся бэкендом (нормализованные тайлы) */
  tiles?: CameraTile[];
  /** отправляется фронтом при mode='grid' */
  regions?: CameraRegion[];
}

/** Стриминг потока: имя отображается, если enabled. */
export interface StreamingDesc {
  enabled: boolean;
  name: string;
}

/** Дескриптор активного потока — тело POST /neural/state */
export interface ActiveDesc {
  config_id: string;
  /** старый формат — бэкенд всё ещё принимает как фоллбэк */
  camera_matrix?: CameraMatrix;
  /** новый богатый формат раскладки (предпочтителен) */
  camera_layout?: CameraLayout;
  cores: number[];
  streaming?: StreamingDesc;
  event_mask?: string[];
}

/** Запись из GET /neural/status */
export interface SlotStatus {
  config_id: string;
  running: boolean;
  camera_matrix: CameraMatrix;
  camera_layout?: CameraLayout;
  cores: number[];
}

/** Тип платформы и лимиты из GET /neural/system */
export interface SystemInfo {
  platform: 'rk3566' | 'rk3588' | 'nvidia' | 'unknown';
  label: string;
  npu_cores: number;
  /** -1 — без ограничений */
  max_streams: number;
  mode: 'single' | 'cores' | 'unlimited';
}

/** Файл модели из GET /neural/models */
export interface ModelFile {
  filename: string;
  size: number;
  path: string;
}

export type ImportMode = 'merge' | 'replace';

/** Ядра NPU — сервер допускает индексы 0..2 (validate_no_core_conflicts) */
export const NPU_CORES = [0, 1, 2] as const;
export type CoreId = (typeof NPU_CORES)[number];

/** Поток камеры (controller.cpp make_pipeline_json) */
export interface CameraStreamInfo {
  width?: number;
  height?: number;
  sub_stream?: number;
  type?: number;
  name?: string;
}

/** Камера из GET /camera (controller.cpp) */
export interface CameraInfo {
  display_name?: string;
  type?: number;
  camera_type?: number;
  description?: string;
  streams?: Record<string, CameraStreamInfo>;
}
