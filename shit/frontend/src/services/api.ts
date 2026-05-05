import { FASTAPI_BASE } from '../utils/constants';
import type { CPPCamera } from '../types';

// === Типы для PATCH ===
// Бэк принимает { meta?: {...}, critical?: {...} }.
// meta — не перезапускает камеру (сейчас только display_name).
// critical — перезапускает. password ВНУТРИ critical отправлять ТОЛЬКО если реально меняем,
// иначе бэк затрёт текущий (договорённость с Ваней от 05.05).
export interface CameraMetaPatch {
  display_name?: string;
  description?: string;
}

export interface CameraCriticalPatch {
  ip_adress?: string;
  port?: string;
  user?: string;
  password?: string; // ⚠️ включать в объект только при реальной смене
  production?: number;
  type?: number;
  streams?: {
    main: {
      sub: number;
      type: number;
      latency: number;
      use_udp: boolean;
      reconnect: number;
      record_path: string;
      segment: number;
    };
    sub: {
      sub: number;
      type: number;
      latency: number;
      use_udp: boolean;
      reconnect: number;
      record_path: string;
      segment: number;
    };
  };
}

export interface CameraPatchBody {
  meta?: CameraMetaPatch;
  critical?: CameraCriticalPatch;
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async getCameras(): Promise<CPPCamera[]> {
    const response = await fetch(`${this.baseUrl}/api/cameras`);
    if (!response.ok) throw new Error('Failed to fetch cameras');

    const data = await response.json();

    // Формат 1: { cameras: [...] }
    if (data.cameras && Array.isArray(data.cameras)) {
      return data.cameras.map((c: any) => this.normalizeCamera(c));
    }

    // Формат 2: { cameras: { camera_1: {...}, camera_2: {...} } } — легаси,
    // на случай если бэк где-то ещё отдаёт старый вид.
    if (data.cameras && typeof data.cameras === 'object') {
      console.log('📦 Converting cameras object to array (legacy format)...');
      return Object.entries(data.cameras).map(([key, cameraData]: [string, any]) =>
        this.normalizeCamera({ id: cameraData.id ?? key, ...cameraData })
      );
    }

    // Формат 3: массив напрямую
    if (Array.isArray(data)) {
      return data.map((c: any) => this.normalizeCamera(c));
    }

    console.error('❌ getCameras() returned unexpected format:', data);
    return [];
  }

  async getCamera(cameraId: string): Promise<CPPCamera | null> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraId}`);
    if (!response.ok) throw new Error('Camera not found');

    const data = await response.json();
    if (!data) return null;

    return this.normalizeCamera({ id: data.id ?? cameraId, ...data });
  }

  async createCamera(camera: CPPCamera): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/camera`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(camera),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to create camera');
    }
    return response.json();
  }

  /**
   * PATCH камеры.
   * ⚠️ Важно: `password` внутри `updates.critical` должен быть задан ТОЛЬКО если
   * пользователь реально вводит новый пароль. Пустая строка затрёт текущий.
   * Формировать тело нужно на стороне вызывающего кода (CameraSettings).
   */
  async updateCamera(cameraId: string, updates: CameraPatchBody): Promise<any> {
    if (!updates.meta && !updates.critical) {
      // Нечего отправлять — не дёргаем сеть
      return { ok: true, noop: true };
    }

    const response = await fetch(`${this.baseUrl}/api/camera/${cameraId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to update camera');
    }
    return response.json();
  }

  async deleteCamera(cameraId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete camera');
  }

  // === helpers ===
  private normalizeCamera(raw: any): CPPCamera {
    // Совместимость на переходный период: если где-то ещё приходит `name`,
    // считаем его id. display_name падаем обратно на description/id.
    const id: string = raw.id ?? raw.name;
    const display_name: string =
      raw.display_name ?? raw.description ?? id;

    return {
      ...raw,
      id,
      display_name,
    } as CPPCamera;
  }
}

export const api = new ApiClient(FASTAPI_BASE);