// Типы, повторяющие контракт media-center (neural-controller.cpp)

/** Описание модели, записанное в конфигурацию при сохранении или старте слота */
export interface ModelDesc {
    file: string;
    input_width: number;
    input_height: number;
    class_count: number;
    /** SINGLE, SPLIT_LEVELS, SINGLE_SEG, SPLIT_LEVELS_SEG */
    layout: string;
    quantized: boolean;
    weight_bytes: number;
}

/** Краткая запись из GET /neural/configurations */
export interface ConfigSummary {
    id: string;
    name: string;
    /** null или нет — модель не прочитана */
    model?: ModelDesc | null;
}

/** Зона каталога конфигурации; приоритет — место в списке, первая выше всех */
export interface ZoneDef {
    /** С 1, не меняется; 0 — вне зон */
    id: number;
    name: string;
    color: string;
    /** Доля площади детекции в зоне 0..1; 0 — хватает пикселя */
    threshold: number;
}

export interface ThresholdConfig {
    nms: number;
    confidence: number;
    /** Модель с масками: детекция без контура отбрасывается; нет поля — включено */
    require_mask?: boolean;
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

/** Конфиг трекера: type и поля этого типа; набор полей задаёт GET /neural/tracker-types */
export interface TrackerConfig {
    type: string;
    [field: string]: string | number;
}

/** Реализованный тип трекера (GET /neural/tracker-types) */
export interface TrackerType {
    type: string;
    name: string;
    /** Значения по умолчанию; старый media-center их не отдаёт */
    defaults?: Record<string, string | number>;
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
    zones?: ZoneDef[];
    /** Трек переходит в зону выше, когда она держится столько кадров подряд */
    zone_enter_frames?: number;
    /** Трек уходит в зону ниже, когда зоны выше нет столько секунд */
    zone_leave_s?: number;
    /** Пишет устройство, присланное отбрасывается */
    model?: ModelDesc;
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

/** Многоугольник зоны на кадре камеры: точки x, y подряд в долях кадра */
export interface ZonePolygon {
    zone: number;
    points: number[];
}

/** Зоны потока: конфигурация → камера → многоугольники */
export type StreamZones = Record<string, Record<string, ZonePolygon[]>>;

/** Видеопоток из GET /neural/streams: полотно, собранное из тайлов; слот ставится только с моделью того же входа */
export interface VideoStream {
    id: string;
    name: string;
    width: number;
    height: number;
    rows: number;
    cols: number;
    /** Веса дорожек; пусто — все по единице */
    row_fr: number[];
    col_fr: number[];
    tiles: StreamTile[];
    zones?: StreamZones;
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

/** Дескриптор слота — элемент тела POST /neural/state; пара (stream_id, config_id) уникальна */
export interface ActiveDesc {
    stream_id: string;
    config_id: string;
    /** Кадров в полёте = контекстов NPU на слот, ≥ 1 */
    depth: number;
    /** Потолок кадров в секунду, ≥ 1 */
    fps: number;
    streaming?: StreamingDesc;
    // События, на которые берётся снимок кадра камеры
    image_mask?: string[];
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
    /** Раскладка выходов модели: SINGLE, SPLIT_LEVELS, SINGLE_SEG, SPLIT_LEVELS_SEG, UNKNOWN */
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

/** Камера из GET /api/cameras */
export interface CameraInfo {
    display_name?: string;
    description?: string;
    streams?: Record<string, CameraStreamInfo>;
    // Устройство-владелец из агрегированного списка бэкенда
    device_id?: string;
    device_name?: string;
}
