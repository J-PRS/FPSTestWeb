class NetworkManager {
  serverUrl: string;
  ws: WebSocket | null;
  connected: boolean;
  playerId: string | null;
  onMessageCallback: ((data: any) => void) | null;
  onConnectCallback: ((playerId: string) => void) | null;
  lastMessageTime: number;
  messageCount: number;
  packetLossCount: number;
  networkQuality: number;
  lastPingTime: number;
  currentLatency: number;
  pingTimer: number;
  PING_INTERVAL: number;
  reconnectAttempts: number;
  MAX_RECONNECT_ATTEMPTS: number;
  RECONNECT_BASE_DELAY: number;
  reconnectTimer: number;
  shouldReconnect: boolean;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.connected = false;
    this.playerId = null;
    this.onMessageCallback = null;
    this.onConnectCallback = null;
    
    // Network quality tracking
    this.lastMessageTime = 0;
    this.messageCount = 0;
    this.packetLossCount = 0;
    this.networkQuality = 1.0;
    this.lastPingTime = 0;
    this.currentLatency = 0;
    this.pingTimer = 0;
    this.PING_INTERVAL = 1.0;
    
    // Auto-reconnect
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 5;
    this.RECONNECT_BASE_DELAY = 2.0;
    this.reconnectTimer = 0;
    this.shouldReconnect = true;
    
    this.tryConnect();
  }
  
  tryConnect(): void {
    try {
      // console.log('Connecting to ' + this.serverUrl + '...');
      this.ws = new WebSocket(this.serverUrl);
      this.ws.onopen = () => this.onOpen();
      this.ws.onmessage = (event) => this.onWsMessage(event);
      this.ws.onerror = (event) => this.onError(event);
      this.ws.onclose = (event) => this.onClose(event);
    } catch (e) {
      console.error('WebSocket connection failed:', e);
      this.scheduleReconnect();
    }
  }
  
  scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      // console.log('Max reconnection attempts reached or reconnect disabled');
      return;
    }
    this.reconnectAttempts++;
    this.reconnectTimer = this.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1);
    // console.log(`Reconnecting in ${this.reconnectTimer}s (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
  }
  
  onOpen(): void {
    this.connected = true;
    this.reconnectAttempts = 0;
    this.reconnectTimer = 0;
    // console.log('WebSocket connected');
  }
  
  onWsMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data);
      
      // Track network quality
      const now = performance.now() / 1000;
      this.messageCount++;
      
      // Detect packet loss
      if (this.lastMessageTime > 0 && (now - this.lastMessageTime) > 0.5) {
        this.packetLossCount++;
      }
      this.lastMessageTime = now;
      
      // Calculate network quality
      if (this.messageCount > 10) {
        const lossRate = this.packetLossCount / this.messageCount;
        this.networkQuality = 1.0 - Math.min(lossRate * 5, 1.0);
      }
      
      // Handle pong for latency measurement
      if (data.type === 'pong') {
        const now = performance.now() / 1000;
        this.currentLatency = (now - data.time) * 1000;
      }
      
      if (data.type === 'init') {
        this.playerId = data.playerId;
        if (this.onConnectCallback) {
          this.onConnectCallback(this.playerId);
        }
      }
      
      if (this.onMessageCallback) {
        this.onMessageCallback(data);
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  }
  
  onError(event: Event): void {
    // console.error('WebSocket error');
  }
  
  onClose(event: CloseEvent): void {
    this.connected = false;
    // console.log('WebSocket disconnected');
    this.scheduleReconnect();
  }
  
  update(dt: number): void {
    // Handle reconnect timer
    if (this.reconnectTimer > 0) {
      this.reconnectTimer -= dt;
      if (this.reconnectTimer <= 0) {
        this.reconnectTimer = 0;
        this.tryConnect();
      }
    }
    
    // Send periodic ping
    if (this.connected) {
      this.pingTimer += dt;
      if (this.pingTimer >= this.PING_INTERVAL) {
        this.pingTimer = 0;
        this.sendPing();
      }
    }
  }
  
  sendPositionUpdate(pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number }, seq?: number): void {
    if (!this.connected) return;
    
    try {
      const msg: any = {
        type: 'positionUpdate',
        position: pos,
        rotation: rot
      };
      if (seq !== undefined) {
        msg.seq = seq;
      }
      this.ws!.send(JSON.stringify(msg));
    } catch (e) {
      console.error('Error sending position:', e);
    }
  }
  
  sendRocketFire(pos: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, timestamp?: number): void {
    if (!this.connected) return;
    
    try {
      const msg: any = {
        type: 'rocketFire',
        position: pos,
        direction: dir
      };
      if (timestamp !== undefined) {
        msg.timestamp = timestamp;
      }
      this.ws!.send(JSON.stringify(msg));
    } catch (e) {
      console.error('Error sending rocket fire:', e);
    }
  }
  
  sendRocketExplode(pos: { x: number; y: number; z: number }, timestamp?: number): void {
    if (!this.connected) return;
    
    try {
      const msg: any = {
        type: 'rocketExplode',
        position: pos
      };
      if (timestamp !== undefined) {
        msg.timestamp = timestamp;
      }
      this.ws!.send(JSON.stringify(msg));
    } catch (e) {
      console.error('Error sending rocket explode:', e);
    }
  }
  
  sendSetName(name: string): void {
    if (!this.connected) return;
    try {
      this.ws!.send(JSON.stringify({
        type: 'setName',
        name: name
      }));
    } catch (e) {
      console.error('Error sending setName:', e);
    }
  }
  
  setOnMessage(callback: (data: any) => void): void {
    this.onMessageCallback = callback;
  }
  
  onConnect(callback: (playerId: string) => void): void {
    this.onConnectCallback = callback;
  }
  
  getPlayerId(): string | null {
    return this.playerId;
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  getNetworkQuality(): number {
    return this.networkQuality;
  }
  
  getLatency(): number {
    return this.currentLatency;
  }
  
  sendPing(): void {
    if (!this.connected) return;
    try {
      this.lastPingTime = performance.now() / 1000;
      this.ws!.send(JSON.stringify({
        type: 'ping',
        time: this.lastPingTime
      }));
    } catch (e) {
      console.error('Error sending ping:', e);
    }
  }
}

export default NetworkManager;
