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

/** Ячейка сетки-редактора (mode='grid') */
export interface CameraRegion {
    row: number;
    col: number;
    row_span: number;
    col_span: number;
    camera: string;
}

/** Нормализованный тайл камеры, доли кадра [0..1] */
export interface CameraTile {
    camera: string;
    rect: [number, number, number, number];
}

/** Раскладка камер слота; конвейер обрабатывает только single */
export interface CameraLayout {
    mode: 'single' | 'grid';
    rows: number;
    cols: number;
    single?: string;
    tiles?: CameraTile[];
    regions?: CameraRegion[];
}

export interface StreamingDesc {
    enabled: boolean;
    name: string;
}

/** Дескриптор слота — элемент тела POST /neural/state */
export interface ActiveDesc {
    config_id: string;
    camera_layout: CameraLayout;
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
    config_id: string;
    running: boolean;
    camera_layout?: CameraLayout;
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
