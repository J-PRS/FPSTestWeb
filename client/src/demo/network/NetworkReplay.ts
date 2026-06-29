import { DemoFile } from '../types/DemoFile.js';
import { DemoSerializer } from '../serialization/DemoSerializer.js';

/**
 * Network replay packet.
 */
export interface ReplayPacket {
  /** Packet type */
  type: 'start' | 'frame' | 'event' | 'end' | 'seek' | 'speed';
  /** Timestamp */
  timestamp: number;
  /** Data */
  data: any;
}

/**
 * Network replay configuration.
 */
export interface NetworkReplayConfig {
  /** Server URL */
  serverUrl: string;
  /** Room ID */
  roomId: string;
  /** Whether to host */
  isHost: boolean;
}

/**
 * Network replay system.
 * Synchronize demo playback across multiple clients.
 */
export class NetworkReplay {
  private config: NetworkReplayConfig | null = null;
  private websocket: WebSocket | null = null;
  private isConnected: boolean = false;
  private onPacketCallback: ((packet: ReplayPacket) => void) | null = null;

  /**
   * Initialize network replay.
   * @param config - Replay configuration
   */
  initialize(config: NetworkReplayConfig): void {
    this.config = config;
    this.connect();
  }

  /**
   * Connect to replay server.
   */
  private connect(): void {
    if (!this.config) {
      return;
    }

    const wsUrl = `${this.config.serverUrl}?room=${this.config.roomId}&host=${this.config.isHost}`;
    this.websocket = new WebSocket(wsUrl);

    this.websocket.onopen = () => {
      this.isConnected = true;
      console.log('[NetworkReplay] Connected to replay server');
    };

    this.websocket.onmessage = (event) => {
      const packet: ReplayPacket = JSON.parse(event.data);
      this.handlePacket(packet);
    };

    this.websocket.onerror = (error) => {
      console.error('[NetworkReplay] WebSocket error:', error);
    };

    this.websocket.onclose = () => {
      this.isConnected = false;
      console.log('[NetworkReplay] Disconnected from replay server');
    };
  }

  /**
   * Handle incoming packet.
   * @param packet - Replay packet
   */
  private handlePacket(packet: ReplayPacket): void {
    if (this.onPacketCallback) {
      this.onPacketCallback(packet);
    }
  }

  /**
   * Send a packet.
   * @param packet - Replay packet
   */
  sendPacket(packet: ReplayPacket): void {
    if (this.websocket && this.isConnected) {
      this.websocket.send(JSON.stringify(packet));
    }
  }

  /**
   * Start replay.
   * @param demo - Demo file
   */
  startReplay(demo: DemoFile): void {
    const data = DemoSerializer.serialize(demo);
    const base64 = this.arrayBufferToBase64(data.buffer.slice(0) as ArrayBuffer);

    this.sendPacket({
      type: 'start',
      timestamp: Date.now(),
      data: { demoData: base64 },
    });
  }

  /**
   * Send frame update.
   * @param frameIndex - Frame index
   * @param timestamp - Playback timestamp
   */
  sendFrame(frameIndex: number, timestamp: number): void {
    this.sendPacket({
      type: 'frame',
      timestamp: Date.now(),
      data: { frameIndex, playbackTime: timestamp },
    });
  }

  /**
   * Send event update.
   * @param eventType - Event type
   * @param timestamp - Event timestamp
   */
  sendEvent(eventType: string, timestamp: number): void {
    this.sendPacket({
      type: 'event',
      timestamp: Date.now(),
      data: { eventType, eventTime: timestamp },
    });
  }

  /**
   * Seek to time.
   * @param time - Time to seek to
   */
  seek(time: number): void {
    this.sendPacket({
      type: 'seek',
      timestamp: Date.now(),
      data: { time },
    });
  }

  /**
   * Set playback speed.
   * @param speed - Playback speed
   */
  setSpeed(speed: number): void {
    this.sendPacket({
      type: 'speed',
      timestamp: Date.now(),
      data: { speed },
    });
  }

  /**
   * End replay.
   */
  endReplay(): void {
    this.sendPacket({
      type: 'end',
      timestamp: Date.now(),
      data: {},
    });
  }

  /**
   * Set packet callback.
   * @param callback - Callback function
   */
  onPacket(callback: (packet: ReplayPacket) => void): void {
    this.onPacketCallback = callback;
  }

  /**
   * Check if connected.
   * @returns Connection status
   */
  isConnectionActive(): boolean {
    return this.isConnected;
  }

  /**
   * Disconnect from server.
   */
  disconnect(): void {
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    this.isConnected = false;
  }

  /**
   * Convert ArrayBuffer to Base64.
   * @param buffer - ArrayBuffer
   * @returns Base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
