// Типы, повторяющие контракт media-center (neural-controller.cpp)

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

/** Конфиг трекера; json-configurator читает type "iou" */
export interface TrackerConfig {
    type: string;
    iou_threshold: number;
    min_hits: number;
    max_lost: number;
    move_threshold: number;
}

/** Реализованный тип трекера (GET /neural/tracker-types) */
export interface TrackerType {
    type: string;
    name: string;
}

/** Тип события трека (GET /neural/event-types) — только идентификатор */
export interface TrackEventType {
    type: string;
}

/** Полный JSON конфигурации (GET /neural/configurations?id=...); размер входа задаёт модель */
export interface NeuralConfig {
    name: string;
    model_path: string;
    thresholds: ThresholdConfig;
    /** null или отсутствие — трекер выключен */
    tracker?: TrackerConfig | null;
    superclasses: Record<string, SuperclassDef>;
    classes: Record<string, ClassDef>;
}

export type TileFit = 'letterbox' | 'stretch';

/** Тайл видеопотока: камера, место в сетке, окно кадра в долях [x, y, w, h] и вписывание */
export interface StreamTile {
    camera: string;
    row: number;
    col: number;
    row_span: number;
    col_span: number;
    crop: [number, number, number, number];
    fit: TileFit;
}

/** Видеопоток из GET /neural/streams: полотно размером с вход модели, собранное из тайлов */
export interface VideoStream {
    id: string;
    name: string;
    /** Пусто — конфигурация удалена, поток живёт под сохранённый размер */
    config_id: string;
    width: number;
    height: number;
    rows: number;
    cols: number;
    /** Веса дорожек; пусто — все по единице */
    row_fr: number[];
    col_fr: number[];
    tiles: StreamTile[];
}

export type TileState = 'ok' | 'no_camera' | 'stalled';

/** Размещение тайла на полотне за последний тик: ячейка и область картинки в пикселях полотна */
export interface TilePlacement {
    camera: string;
    state: TileState;
    cell: [number, number, number, number];
    rect: [number, number, number, number];
    camera_width: number;
    camera_height: number;
}

export interface StreamingDesc {
    enabled: boolean;
    name: string;
}

/** Дескриптор слота — элемент тела POST /neural/state; конфигурация выводится из видеопотока */
export interface ActiveDesc {
    stream_id: string;
    /** Только в ответе GET /neural/state */
    config_id?: string;
    /** Кадров в полёте = контекстов NPU на слот, ≥ 1 */
    depth: number;
    /** Потолок кадров в секунду, ≥ 1 */
    fps: number;
    streaming?: StreamingDesc;
    event_mask?: string[];
}

export interface TensorInfo {
    name: string;
    dims: number[];
    type: string;
    format: string;
    scale: number;
    zp: number;
}

/** Сведения о модели, прочитанные при загрузке в NPU */
export interface ModelInfo {
    path: string;
    class_count: number;
    input_width: number;
    input_height: number;
    input_channels: number;
    quantized: boolean;
    inputs: TensorInfo[];
    outputs: TensorInfo[];
    api_version: string;
    driver_version: string;
    weight_bytes: number;
    internal_bytes: number;
}

/** Запись из GET /neural/status */
export interface SlotStatus {
    stream_id: string;
    config_id: string;
    running: boolean;
    canvas: { width: number; height: number };
    /** Пусто — полотно ещё не собиралось */
    tiles: TilePlacement[];
    depth: number;
    depth_actual: number;
    fps_limit: number;
    /** Раскладка выходов модели: SINGLE, SPLIT_LEVELS, SEGMENTATION, UNKNOWN */
    layout: string;
    model?: ModelInfo;
    /** 0 — ошибки нет, иначе код 6xxx */
    code: number;
    error: string;
    infer_ms: number;
    wait_ms: number;
    fps: number;
    detections: number;
    tracks: number;
    dropped: number;
}

/** Платформа из GET /neural/system */
export interface SystemInfo {
    platform: 'rk3566' | 'rk3588' | 'nvidia' | 'unknown';
    label: string;
    npu_cores: number;
}

/** Файл модели из GET /neural/models */
export interface ModelFile {
    filename: string;
    size: number;
    path: string;
}

export type ImportMode = 'merge' | 'replace';

/** Поток камеры из GET /api/cameras */
export interface CameraStreamInfo {
    width?: number;
    height?: number;
    sub_stream?: number;
    purposes?: string[];
    name?: string;
}

/** Камера из GET /api/cameras; type и camera_type читает таблица соответствий КРСПС */
export interface CameraInfo {
    display_name?: string;
    description?: string;
    type?: number;
    camera_type?: number;
    streams?: Record<string, CameraStreamInfo>;
}
