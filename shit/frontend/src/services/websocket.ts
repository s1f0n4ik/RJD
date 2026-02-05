import { WS_URL } from '../utils/constants';
import { SystemState, WebSocketMessage } from '../types';

export class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectInterval: number = 3000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  connect(onStateUpdate: (state: SystemState) => void, onConnectionChange: (connected: boolean) => void) {
    if (this.ws) {
      console.warn('WebSocket already connected');
      return;
    }

    this.ws = new WebSocket(WS_URL);

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
          console.log('📦 State updated');
          onStateUpdate(message.data as SystemState);
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