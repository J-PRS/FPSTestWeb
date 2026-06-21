export interface NetworkMessage {
  type: string;
  [key: string]: any;
}

export class NetworkManager {
  private ws: WebSocket | null = null;
  private playerId: string = '';
  private isConnected: boolean = false;
  private messageHandlers: Map<string, (data: any) => void> = new Map();
  private onConnectCallback: ((playerId: string) => void) | null = null;
  private latency: number = 0;
  private lastPingTime: number = 0;
  private networkQuality: number = 1.0;

  constructor(private url: string = 'ws://localhost:8095') {
    this.connect();
  }

  private connect() {
    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        this.isConnected = true;
        console.log('Connected to server');
      };

      this.ws.onmessage = (event) => {
        const data: NetworkMessage = JSON.parse(event.data);
        
        if (data.type === 'init') {
          this.playerId = data.playerId || this.generatePlayerId();
          if (this.onConnectCallback) {
            this.onConnectCallback(this.playerId);
          }
        } else if (data.type === 'pong') {
          this.latency = Date.now() - this.lastPingTime;
          this.networkQuality = Math.max(0, Math.min(1, 1 - (this.latency / 500)));
        } else {
          const handler = this.messageHandlers.get(data.type);
          if (handler) {
            handler(data);
          }
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        console.log('Disconnected from server');
        // Reconnect after 3 seconds
        setTimeout(() => this.connect(), 3000);
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Failed to connect:', error);
      setTimeout(() => this.connect(), 3000);
    }
  }

  private generatePlayerId(): string {
    return 'player_' + Math.random().toString(36).substr(2, 9);
  }

  onConnect(callback: (playerId: string) => void) {
    this.onConnectCallback = callback;
  }

  onMessage(type: string, handler: (data: any) => void) {
    this.messageHandlers.set(type, handler);
  }

  send(data: NetworkMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendPlayerPosition(position: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number }, seq: number) {
    this.send({
      type: 'playerPosition',
      position,
      rotation,
      seq
    });
  }

  sendRocketFire(position: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }) {
    this.send({
      type: 'rocketFire',
      position,
      direction
    });
  }

  sendRocketExplode(position: { x: number; y: number; z: number }) {
    this.send({
      type: 'rocketExplode',
      position
    });
  }

  sendPing() {
    this.lastPingTime = Date.now();
    this.send({ type: 'ping' });
  }

  getPlayerId(): string {
    return this.playerId;
  }

  getConnected(): boolean {
    return this.isConnected;
  }

  getLatency(): number {
    return this.latency;
  }

  getNetworkQuality(): number {
    return this.networkQuality;
  }

  update(_dt: number) {
    // Network update logic if needed
  }
}
