/**
 * Networking adapter interface for dependency injection
 * Allows swapping between different networking libraries (ws, Colyseus, Rivalis, etc.)
 */
export interface INetworkAdapter {
  connect(url: string): Promise<void>;
  disconnect(): void;
  send(data: any): void;
  sendBinary(data: Uint8Array): void;
  onMessage(callback: (data: any) => void): void;
  onBinaryMessage(callback: (data: Uint8Array) => void): void;
  onConnect(callback: () => void): void;
  onDisconnect(callback: () => void): void;
  onError(callback: (error: Error) => void): void;
  isConnected(): boolean;
}

export interface PlayerState {
  playerId: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  timestamp: number;
  isDead?: boolean;
}

export interface InputState {
  forward: boolean;
  right: boolean;
  jump: boolean;
  shoot: boolean;
  mouseDeltaX: number;
  mouseDeltaY: number;
  sequenceNumber: number;
  timestamp: number;
}
