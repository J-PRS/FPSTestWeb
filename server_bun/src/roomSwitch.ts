/**
 * RoomSwitcher — mid-match room hops. Same socket, new membership: reuses
 * the leave teardown + SessionManager's join tail, so the fresh gameState
 * the new room emits drives the client's existing (re)connect rebuild and
 * the wire needs no new shape. Split out of GameServer so the dispatcher
 * stays about sockets while this owns seat transfers.
 */
import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import type { Room } from './Room.ts';
import type { PlayerState } from './types.ts';
import type { TransportKind } from '../../shared/protocol.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import { wallNow } from './wallClock.ts';

// Room/map/mode name grammar — bad values fall through to 'default'.
const word = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[\w-]{1,32}$/.test(v) ? v : undefined;

export interface SwitchHost {
  roomOfPlayer(playerId: string): Room | undefined;
  roomFor(name: string, mode?: string, map?: string, bots?: number): Room;
  removePlayerCompletely(room: Room, playerId: string, reason: string): void;
  totalPlayers(): number;
  playerRoom: Map<string, Room>;
  sessions: { tokenFor(playerId: string): string };
}

export class RoomSwitcher {
  // Switch-spam guard: reseating a session tears down/rebuilds a player
  // record plus two broadcasts — cheap per hop, but a 20Hz spammer would
  // churn two rooms' rosters for free. A short cooldown is plenty.
  private cooldowns = new Map<string, number>();
  private static readonly SWITCH_COOLDOWN_MS = 1500;

  constructor(private host: SwitchHost) {}

  switchRoom(ws: ServerWebSocket<WebSocketData>, playerId: string, raw: unknown): void {
    if (this.throttled(playerId)) return;

    const target = this.switchTarget(playerId, raw as { room?: string; map?: string; mode?: string; bots?: number });
    if (!target) return;
    const { from, to, prev } = target;

    // Leave teardown: the disconnect path minus the grace window.
    from.connections.unregister(playerId);
    from.rateLimiter.removePlayer(playerId);
    from.messages.onPlayerDisconnected(playerId);
    this.host.removePlayerCompletely(from, playerId, 'roomSwitch');

    this.seatPlayer(to, ws, playerId, prev?.perk ?? 'none', prev?.armorClass ?? 'medium', prev?.transport);
    // Banked respawn edits ride the hop too — a hop is a seat transfer,
    // not a respawn, so a queued class/perk swap must survive it or the
    // client's declared next-life loadout silently vanishes.
    if (prev) {
      const reseated = to.players.getPlayer(playerId);
      if (reseated) {
        reseated.pendingClass = prev.pendingClass;
        reseated.pendingPerk = prev.pendingPerk;
      }
    }
    logger.info('Player switched rooms', { playerId, from: from.name, to: to.name });
  }

  /** Everything that can deny a hop before teardown — null means the
   *  request dies here (with the client notified when it's worth it). */
  private switchTarget(playerId: string, msg: { room?: string; map?: string; mode?: string; bots?: number }): { from: Room; to: Room; prev?: PlayerState } | null {
    const name = word(msg.room) ?? 'default';
    const from = this.host.roomOfPlayer(playerId);
    if (!from) return null;
    if (from.name === name) return null; // already seated — no-op, not an error

    // Dead players can't hop — reseating runs addPlayer, which spawns
    // alive, so a hop would dodge the whole respawn delay. Check BEFORE
    // roomFor: a denied hop must not build a room nobody enters (the
    // cooldown bounds it, but a dead spammer would still churn a fresh
    // map spec per 1.5s window).
    const prev = from.players.getPlayer(playerId);
    if (prev?.isDead) {
      from.connections.sendToPlayer(playerId, { type: 'matchNotice', text: 'Respawning — hold on' });
      return null;
    }

    const bots = typeof msg.bots === 'number' && Number.isFinite(msg.bots)
      ? Math.max(0, Math.min(24, Math.floor(msg.bots))) : undefined;
    const to = this.host.roomFor(name, word(msg.mode) ?? '', word(msg.map) ?? '', bots);
    if (this.roomFull(to)) {
      from.connections.sendToPlayer(playerId, { type: 'matchNotice', text: `${name} is full` });
      return null;
    }

    // The kit rides with the player — the hop isn't a loadout reset.
    return { from, to, prev: prev ?? undefined };
  }

  /** The join tail a room hop shares with SessionManager's accept path —
   *  token, roster entry, socket registration, handshake replay. */
  private seatPlayer(room: Room, ws: ServerWebSocket<WebSocketData>, playerId: string, perk: string, armorClass: string, transport?: TransportKind): void {
    const sessionToken = this.host.sessions.tokenFor(playerId);
    room.sessionTokens.set(playerId, sessionToken);
    const joined = room.players.addPlayer(playerId, room.nextTeam(), perk, armorClass);
    if (transport) joined.transport = transport;
    // Room hops don't stop the client's stream: reports emitted in the
    // OLD room keep arriving for ~1 RTT and would poison the fresh
    // anchor (first straggler seats lastPosCheckPos, the post-hop spawn
    // report then reads as an impossible 100m+ jump). Mute the
    // plausibility gate + shadow judge for the same drain window a
    // correction gets.
    joined.correctionGraceUntil = wallNow() + CONFIG.reportGraceMs;
    this.host.playerRoom.set(playerId, room);
    room.connections.register(playerId, ws);
    room.messages.handleHandshake(playerId, sessionToken);
    // The shadow is created inside handleHandshake — arm its drain
    // window after it exists.
    room.moveSim.markReseated(playerId);
  }

  private throttled(playerId: string): boolean {
    const now = wallNow();
    if (now - (this.cooldowns.get(playerId) ?? 0) < RoomSwitcher.SWITCH_COOLDOWN_MS) return true;
    // Mark on attempt — denied paths (room full, dead, no-op) stay
    // throttled too or switchRoom name-spam churns roomFor unbounded.
    this.cooldowns.set(playerId, now);
    // Server-lifetime map: hoppers keep their entry past removal (the
    // cooldown must survive the hop), so cap growth like duelStart.
    if (this.cooldowns.size > 1024) this.cooldowns.clear();
    return false;
  }

  private roomFull(room: Room): boolean {
    return room.playerCount() >= CONFIG.maxPlayers ||
      (CONFIG.globalMaxPlayers > 0 && this.host.totalPlayers() >= CONFIG.globalMaxPlayers);
  }
}
