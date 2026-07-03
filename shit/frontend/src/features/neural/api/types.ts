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

/** Полный JSON конфигурации (GET /neural/configurations?id=...) */
export interface NeuralConfig {
  name: string;
  model_path: string;
  model_width: number;
  model_height: number;
  thresholds: ThresholdConfig;
  superclasses: Record<string, SuperclassDef>;
  classes: Record<string, ClassDef>;
}

/** Матрица камер: строки → камеры */
export type CameraMatrix = string[][];

/** Дескриптор активного слота — тело POST /neural/state */
export interface ActiveDesc {
  config_id: string;
  camera_matrix: CameraMatrix;
  cores: number[];
}

/** Запись из GET /neural/status */
export interface SlotStatus {
  config_id: string;
  running: boolean;
  camera_matrix: CameraMatrix;
  cores: number[];
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
