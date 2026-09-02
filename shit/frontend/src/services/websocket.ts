import { wsUrl } from '../utils/constants';
import type {SystemState, WebSocketMessage} from '../types';

export class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectInterval: number = 3000;
  // @ts-ignore
    private reconnectTimer: NodeJS.Timeout | null = null;

  connect(onStateUpdate: (state: SystemState) => void, onConnectionChange: (connected: boolean) => void) {
    if (this.ws) {
      console.warn('WebSocket already connected');
      return;
    }

      this.ws = new WebSocket(wsUrl('/ws'));;

    this.ws.onopen = () => {
      console.log('✅ WebSocket Connected');
      onConnectionChange(true);

      // Отправляем подписку на обновления
      this.send({ type: 'subscribe' });
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);

        if (message.type === 'initial_state' || message.type === 'status_update') {
          // console.log('📦 State received');

          const stateData = message.data as SystemState;

          // ✅ ПРЕОБРАЗУЕМ объект cameras в массив + добавляем name
          if (stateData && stateData.cameras) {
            if (!Array.isArray(stateData.cameras)) {

              const camerasObj = stateData.cameras as any;
              // Ключ словаря — это camera_id, весь код читает его как id
              stateData.cameras = Object.entries(camerasObj).map(([id, data]: [string, any]) => ({
                id,
                ...data
              }));
            }
          } else {
            stateData.cameras = [];
          }

          // ✅ ПРЕОБРАЗУЕМ loaders
          if (stateData && stateData.loaders) {
            if (!Array.isArray(stateData.loaders)) {
              console.warn('⚠️ loaders is object, converting to array...');
              stateData.loaders = Object.values(stateData.loaders);
            }
          } else {
            stateData.loaders = [];
          }

          // console.log('📦 State updated:', {
          //   cameras: stateData.cameras.length,
          //   loaders: stateData.loaders.length
          // });

          onStateUpdate(stateData);
        }
      } catch (err) {
        console.error('❌ Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('🔌 WebSocket Disconnected');
      onConnectionChange(false);
      this.ws = null;

      // Автоматическое переподключение
      this.scheduleReconnect(onStateUpdate, onConnectionChange);
    };

    this.ws.onerror = (error) => {
      console.error('❌ WebSocket Error:', error);
    };
  }

  private scheduleReconnect(
    onStateUpdate: (state: SystemState) => void,
    onConnectionChange: (connected: boolean) => void
  ) {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      console.log('🔄 Reconnecting WebSocket...');
      this.reconnectTimer = null;
      this.connect(onStateUpdate, onConnectionChange);
    }, this.reconnectInterval);
  }

  send(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const wsService = new WebSocketService();