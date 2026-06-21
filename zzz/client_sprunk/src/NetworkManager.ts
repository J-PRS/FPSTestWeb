export class NetworkManager {
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private enabled: boolean = true;

  constructor(serverUrl: string) {
    this.connect(serverUrl);
  }

  private connect(serverUrl: string): void {
    if (!this.enabled) return;
    
    try {
      this.ws = new WebSocket(serverUrl);
      
      this.ws.onopen = () => {
        this.connected = true;
        this.enabled = false; // Disable further connection attempts
      };

      this.ws.onclose = () => {
        this.connected = false;
      };

      this.ws.onerror = () => {
        this.connected = false;
        this.enabled = false; // Disable further connection attempts
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    } catch (error) {
      this.enabled = false;
    }
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      
      // Handle different message types
      switch (message.type) {
        case 'init':
          break;
        case 'playerUpdate':
          // Update other players
          break;
        case 'worldState':
          // Update world state
          break;
        default:
          break;
      }
    } catch (error) {
      // Silently ignore parse errors
    }
  }

  send(message: any): void {
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('Not connected to server');
    }
  }

  update(deltaTime: number): void {
    // Send player state updates
    // This would integrate with the player controller
  }

  isConnected(): boolean {
    return this.connected;
  }
}
