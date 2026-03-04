import { FASTAPI_BASE } from '../utils/constants';

export interface CPPCameraStream {
  type_url: number;
  username: string;
  password: string;
  record_path?: string;
  length?: number;
  delete_delay?: number;
  use_udp: boolean;
  status?: number;
}

export interface CPPCamera {
  name: string;
  description: string;
  main: CPPCameraStream;
  sub: CPPCameraStream;
  reconnect: number;
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

    // ✅ ИСПРАВЛЕНО: Сервер возвращает { cameras: [...], total: N }
    if (data.cameras && Array.isArray(data.cameras)) {
      return data.cameras;
    }

    // Если вернули массив напрямую (старый формат - на всякий случай)
    if (Array.isArray(data)) {
      return data;
    }

    console.error('❌ getCameras() returned unexpected format:', data);
    return [];
  }

  async getCamera(cameraName: string): Promise<CPPCamera> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraName}`);
    if (!response.ok) throw new Error('Camera not found');
    return response.json();
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