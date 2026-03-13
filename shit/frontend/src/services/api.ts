import { FASTAPI_BASE } from '../utils/constants';
import type { CPPCamera } from '../types';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async getCameras(): Promise<CPPCamera[]> {
    const response = await fetch(`${this.baseUrl}/api/cameras`);
    if (!response.ok) throw new Error('Failed to fetch cameras');

    const data = await response.json();

    // ✅ ИСПРАВЛЕНО: Сервер возвращает { cameras: {camera_1: {...}, camera_2: {...}} }
    if (data.cameras) {
      // Если это массив — возвращаем как есть
      if (Array.isArray(data.cameras)) {
        return data.cameras;
      }

      // Если это объект — конвертируем в массив + добавляем name
      if (typeof data.cameras === 'object') {
        console.log('📦 Converting cameras object to array...');
        return Object.entries(data.cameras).map(([name, cameraData]: [string, any]) => ({
          name,
          ...cameraData
        })) as CPPCamera[];
      }
    }

    // Если вернули массив напрямую (старый формат)
    if (Array.isArray(data)) {
      return data;
    }

    console.error('❌ getCameras() returned unexpected format:', data);
    return [];
  }

  async getCamera(cameraName: string): Promise<CPPCamera | null> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraName}`);
    if (!response.ok) throw new Error('Camera not found');

    const data = await response.json();

    // Добавляем name, если его нет
    if (data && !data.name) {
      data.name = cameraName;
    }

    return data;
  }

  async createCamera(camera: CPPCamera): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/camera`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(camera),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to create camera');
    }
    return response.json();
  }

  async updateCamera(cameraName: string, updates: Partial<CPPCamera>): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to update camera');
    }
    return response.json();
  }

  async deleteCamera(cameraName: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraName}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete camera');
  }
}

export const api = new ApiClient(FASTAPI_BASE);
export type { CPPCamera };