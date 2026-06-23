/**
 * Worker-based networking proxy
 * Handles network communication in a web worker to keep the main thread responsive
 */

import { ChildLogger } from './Logger.js';
import { StateSnapshot } from './StateSnapshot.js';

const logger = new ChildLogger('WorkerNetworkManager');

export class WorkerNetworkManager {
  private worker: Worker;
  private localPlayerId: string;
  private players: Map<string, any> = new Map();
  private connected = false;
  private ping = 0;
  private packetLoss = 0;
  private jitter = 0;
  
  // Callbacks
  public onPlayerHit: ((shooterId: string, targetId: string, damage: number) => void) | null = null;
  public onPlayerKill: ((shooterId: string, targetId: string) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onStateRestore: ((state: any) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileUpdate: ((projectileId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number) => void) | null = null;
  public onGameState: ((players: any[], localPlayerState: any) => void) | null = null;
  public onSnapshot: ((snapshot: any) => void) | null = null;
  public onSnapshotRequest: (() => void) | null = null;
  public onRoughStateRequest: (() => void) | null = null;
  public onStateReconciliation: ((state: { position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }, lastProcessedSequence: number }) => void) | null = null;

  constructor(playerId: string) {
    this.localPlayerId = playerId;
    logger.debug('Creating worker...');
    this.worker = new Worker(new URL('./networking/networking.worker.ts', import.meta.url), { type: 'module' });
    logger.debug('Worker created');
    this.setupWorkerHandlers();
  }

  private setupWorkerHandlers() {
    this.worker.onmessage = (e) => {
      const data = e.data;
      switch (data.type) {
        case 'connected':
          this.connected = true;
          logger.info('Connected');
          break;
        case 'disconnected':
          this.connected = false;
          logger.info('Disconnected');
          this.players.clear();
          break;
        case 'error':
          logger.error('Error', data.error);
          break;
        case 'playerJoined':
          if (data.playerId !== this.localPlayerId) {
            this.players.set(data.playerId, {
              playerId: data.playerId,
              position: data.position || { x: 0, y: 0, z: 0 },
              rotation: data.rotation || { yaw: 0, pitch: 0 },
              timestamp: Date.now()
            });
          }
          if (this.onPlayerJoined) this.onPlayerJoined(data.playerId, data.position || { x: 0, y: 0, z: 0 }, data.rotation || { yaw: 0, pitch: 0 });
          break;
        case 'playerLeft':
          this.players.delete(data.playerId);
          if (this.onPlayerLeft) this.onPlayerLeft(data.playerId);
          break;
        case 'playerUpdate':
          if (data.playerId !== this.localPlayerId) {
            this.players.set(data.playerId, {
              playerId: data.playerId,
              position: data.position,
              rotation: data.rotation,
              timestamp: data.timestamp
            });
          }
          if (this.onPlayerUpdate) this.onPlayerUpdate(data.playerId, data.position, data.rotation, data.timestamp);
          break;
        case 'gameState':
          data.players.forEach((p: any) => {
            if (p.playerId !== this.localPlayerId) {
              this.players.set(p.playerId, p);
            }
          });
          if (this.onGameState) this.onGameState(data.players, data.localPlayerState);
          break;
        case 'snapshot':
          if (this.onSnapshot) this.onSnapshot(data);
          break;
        case 'hit':
          if (this.onPlayerHit) this.onPlayerHit(data.shooterId, data.targetId, data.damage);
          break;
        case 'kill':
          if (this.onPlayerKill) this.onPlayerKill(data.shooterId, data.targetId);
          break;
        case 'playerRespawn':
          this.players.set(data.playerId, {
            playerId: data.playerId,
            position: data.position,
            rotation: data.rotation,
            timestamp: Date.now()
          });
          if (this.onPlayerRespawn) this.onPlayerRespawn(data.playerId, data.position, data.rotation);
          break;
        case 'jump':
          if (this.onPlayerJump) this.onPlayerJump(data.playerId, data.position);
          break;
        case 'jetpack':
          if (this.onPlayerJetpack) this.onPlayerJetpack(data.playerId, data.position);
          break;
        case 'projectileCreated':
          if (this.onProjectileCreated) this.onProjectileCreated(data.projectileId, data.ownerId, data.position, data.velocity);
          break;
        case 'projectileUpdate':
          if (this.onProjectileUpdate) this.onProjectileUpdate(data.projectileId, data.position);
          break;
        case 'projectileDestroyed':
          if (this.onProjectileDestroyed) this.onProjectileDestroyed(data.projectileId);
          break;
        case 'stateRestore':
          if (this.onStateRestore) this.onStateRestore(data.state);
          break;
        case 'stateReconciliation':
          if (this.onStateReconciliation) this.onStateReconciliation(data.data);
          break;
        case 'ping':
          this.ping = data.value;
          break;
        case 'packetLoss':
          this.packetLoss = data.value;
          break;
        case 'jitter':
          this.jitter = data.value;
          break;
      }
    };
  }

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        if (e.data.type === 'connected') {
          this.worker.removeEventListener('message', onMessage);
          resolve();
        } else if (e.data.type === 'error') {
          this.worker.removeEventListener('message', onMessage);
          reject(new Error(e.data.error));
        }
      };
      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage({ type: 'connect', url, playerId: this.localPlayerId });
    });
  }

  disconnect(): void {
    this.worker.postMessage({ type: 'disconnect' });
  }

  sendInput(input: any): void {
    this.worker.postMessage({ type: 'sendInput', input });
  }

  send(message: any): void {
    this.worker.postMessage(message);
  }

  sendPosition(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }): void {
    this.worker.postMessage({ type: 'sendPosition', position, rotation });
  }

  sendShot(targetId: string | null, position?: { x: number; y: number; z: number }, velocity?: { x: number; y: number; z: number }, timestamp?: number, projectileId?: string | null, directHit?: boolean): void {
    this.worker.postMessage({ type: 'sendShot', targetId, position, velocity, timestamp, projectileId, directHit });
  }

  sendJump(position: { x: number; y: number; z: number }): void {
    this.worker.postMessage({ type: 'sendJump', position });
  }

  sendJetpack(position: { x: number; y: number; z: number }): void {
    this.worker.postMessage({ type: 'sendJetpack', position });
  }

  sendProjectileDestroy(projectileId: string): void {
    this.worker.postMessage({ type: 'sendProjectileDestroy', projectileId });
  }

  getPlayers(): Map<string, any> {
    return this.players;
  }

  getLocalPlayerId(): string {
    return this.localPlayerId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPing(): number {
    this.worker.postMessage({ type: 'getPing' });
    return this.ping;
  }

  getPacketLoss(): number {
    this.worker.postMessage({ type: 'getPacketLoss' });
    return this.packetLoss;
  }

  getJitter(): number {
    this.worker.postMessage({ type: 'getJitter' });
    return this.jitter;
  }
}
