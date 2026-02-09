import { FASTAPI_BASE } from '../utils/constants';
import { Camera, Loader, CameraFormData } from '../types';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  // ========== Cameras ==========

  async getCameras(): Promise<Camera[]> {
    const response = await fetch(`${this.baseUrl}/api/cameras`);
    if (!response.ok) throw new Error('Failed to fetch cameras');
    return response.json();
  }

  async createCamera(camera: CameraFormData): Promise<Camera> {
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

  async updateCamera(cameraName: string, data: Partial<CameraFormData>): Promise<Camera> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
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
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to delete camera');
    }
  }

  async getCameraStatus(cameraName: string): Promise<Camera> {
    const response = await fetch(`${this.baseUrl}/api/camera/${cameraName}`);
    if (!response.ok) throw new Error('Failed to fetch camera status');
    return response.json();
  }

  // ========== Loaders ==========

  async getLoaders(): Promise<Loader[]> {
    const response = await fetch(`${this.baseUrl}/api/loaders`);
    if (!response.ok) throw new Error('Failed to fetch loaders');
    return response.json();
  }

  async startLoader(loaderName: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/loader/${loaderName}/start`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Failed to start loader');
    return response.json();
  }

  async stopLoader(loaderName: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/loader/${loaderName}/stop`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Failed to stop loader');
    return response.json();
  }
}

export const api = new ApiClient(FASTAPI_BASE);