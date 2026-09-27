/**
 * Room — one match's worth of state: players, sockets, rate limits,
 * message routing, and its own BallSim. GameServer holds a rooms map and
 * dispatches connections to them; today every player lands in "default",
 * but the seam is what turns matchmaking/lobbies/multi-match servers into
 * plumbing instead of surgery.
 *
 * Deliberately owns NO transport specifics beyond the broadcast/send
 * closures it hands to its children — a room is just "everyone who shares
 * this match state."
 */
import { PlayerManager } from './PlayerManager.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { MessageHandler } from './MessageHandler.ts';
import { BallSim } from './BallSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';

export class Room {
  readonly name: string;
  readonly players = new PlayerManager();
  readonly connections = new ConnectionManager();
  readonly rateLimiter = new RateLimiter();
  readonly messages: MessageHandler;
  readonly ballSim: BallSim;

  // Per-room session bookkeeping (was global — a grace-period slot belongs
  // to the match it was in, not the whole server).
  readonly disconnected = new Map<string, { timeout: ReturnType<typeof setTimeout> }>();
  readonly sessionTokens = new Map<string, string>();
  readonly lastSentPositions = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; t: number }>();
  tickSeq = 0;

  constructor(name: string, field: Heightfield | null) {
    this.name = name;
    this.messages = new MessageHandler(
      this.players,
      this.rateLimiter,
      (msg, exclude) => this.connections.broadcast(msg, exclude),
      (pid, msg) => this.connections.sendToPlayer(pid, msg),
    );
    this.ballSim = new BallSim(
      this.players,
      (msg) => this.connections.broadcast(msg),
      (data) => this.connections.broadcastBinary(data),
    );
    this.messages.setBallSim(this.ballSim);
    if (field) this.ballSim.attachField(field);
  }

  broadcast(msg: Parameters<ConnectionManager['broadcast']>[0], exclude?: string): void {
    this.connections.broadcast(msg, exclude);
  }

  playerCount(): number {
    return this.players.getPlayerCount();
  }

  socketOf(playerId: string): ServerWebSocket<WebSocketData> | undefined {
    return this.connections.getConnection(playerId);
  }

  /** Nothing left to serve: no players, no grace-period ghosts. */
  get empty(): boolean {
    return this.players.getPlayerCount() === 0 && this.disconnected.size === 0;
  }

  dispose(): void {
    this.ballSim.stop();
  }

  /** Full teardown — every store moves together or a slot/token leaks. */
  removePlayerCompletely(playerId: string, reason: string, log: (m: string, o?: object) => void): void {
    this.players.removePlayer(playerId);
    this.messages.onPlayerRemoved(playerId);
    this.sessionTokens.delete(playerId);
    this.lastSentPositions.delete(playerId);
    this.connections.broadcast({ type: 'playerLeft', playerId });
    log('Player removed', { room: this.name, playerId, reason, remaining: this.playerCount() });
  }
}
