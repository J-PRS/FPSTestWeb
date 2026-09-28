import type { ServerWebSocket } from 'bun';
import { CONFIG } from './config.ts';
import type { Room } from './Room.ts';
import { validatePlayerId } from './validation.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { isPerkId } from '../../shared/perks.ts';
import { createHmac, randomBytes } from 'node:crypto';

/** Everything the socket lifecycle needs from GameServer — supplied as
 *  closures/maps so ownership stays with the dispatcher. */
export interface SessionDeps {
  rooms: Map<string, Room>;
  /** playerId → room index for the hot paths (binary position 20Hz). */
  playerRoom: Map<string, Room>;
  /** Spectator sockets aren't players — roomOfPlayer can't find them. */
  specRooms: Map<string, Room>;
  roomFor(name: string, mode?: string, map?: string, bots?: number): Room;
  roomOfPlayer(playerId: string): Room | undefined;
  totalPlayers(): number;
  ops: { joins: number; tierWs: number; tierWt: number; tierRtc: number; tierOther: number };
}

/** Join handshake + persistent identity. Handles four join shapes:
 *  session reclaim (grace-period reconnect), spectate, normal join, and
 *  every rejection path (throttle, caps, claimed ids, bad tokens). */
export class SessionManager {
  private static readonly ROOM_NAME_RE = /^[\w-]{1,32}$/;

  // Persistent identity: playerId → HMAC(playerId, secret). A claimed id
  // can't be taken without its token; tokens survive server restarts when
  // FPS_SECRET is set (random per boot otherwise — dev default).
  private identitySecret = CONFIG.identitySecret || randomBytes(32).toString('hex');
  private claimedIdentities = new Map<string, string>();
  // Unbounded by default — a join-spam botnet would otherwise grow this
  // map forever. Past the cap, evict oldest-first (insertion order).
  private static readonly MAX_IDENTITIES = 10_000;

  // Join throttle: ip → sliding window counters. Entries age out with the
  // window so the map self-cleans.
  private joinWindows = new Map<string, { count: number; start: number }>();
  private static readonly JOIN_LIMIT = 5;
  private static readonly JOIN_WINDOW_MS = 60_000;

  constructor(private readonly d: SessionDeps) {}

  private joinThrottleAllow(ip: string): boolean {
    // Loopback is the dev box and the pvptest harness — fleets spawn 24+
    // joins/minute legitimately. Flood control is for real traffic only.
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    const now = Date.now();
    let w = this.joinWindows.get(ip);
    if (!w || now - w.start >= SessionManager.JOIN_WINDOW_MS) {
      w = { count: 0, start: now };
      this.joinWindows.set(ip, w);
    }
    return ++w.count <= SessionManager.JOIN_LIMIT;
  }

  private identityToken(playerId: string): string {
    return createHmac('sha256', this.identitySecret).update(playerId).digest('base64url');
  }

  handle(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) {
      ws.close(1008, 'Invalid handshake');
      return;
    }

    const handshake = raw as Record<string, unknown>;
    if (handshake.type !== 'join') {
      ws.close(1008, 'Expected join handshake');
      return;
    }
    const playerIdResult = validatePlayerId(handshake.playerId);
    if (!playerIdResult.success) {
      logger.warn('Invalid playerId rejected', { error: playerIdResult.error });
      ws.close(1008, 'Invalid playerId');
      return;
    }

    const playerId = playerIdResult.data;

    // Join flood guard: joins bypass the per-player RateLimiter (they ARE
    // the registration), so throttle by source IP — 5 joins/min is generous
    // for humans, lethal for a spammer script.
    if (!this.joinThrottleAllow(ws.remoteAddress)) {
      logger.warn('Join flood rejected', { ip: ws.remoteAddress });
      ws.close(1013, 'Join rate limited');
      return;
    }

    const token = typeof handshake.token === 'string' ? handshake.token : undefined;
    const roomName = typeof handshake.room === 'string' && SessionManager.ROOM_NAME_RE.test(handshake.room)
      ? handshake.room
      : 'default';

    // A reclaim must land in the room the session was in — find by playerId
    // rather than trusting the claimed room (reconnecting to a different
    // room mid-grace would orphan the slot in the old room).
    const reclaimRoom = this.d.roomOfPlayer(playerId);
    if (reclaimRoom) {
      const existingPlayer = reclaimRoom.players.getPlayer(playerId);
      const disconnected = reclaimRoom.disconnected.get(playerId);
      if (existingPlayer && disconnected) {
        // Session reclaim requires the server-issued token — bare playerId
        // knowledge must not be enough to steal a slot
        if (token !== reclaimRoom.sessionTokens.get(playerId)) {
          logger.warn('Reconnect rejected: bad session token', { playerId });
          ws.close(1008, 'Invalid session token');
          return;
        }
        // Cancel grace period removal, reconnect with existing state
        clearTimeout(disconnected.timeout);
        reclaimRoom.disconnected.delete(playerId);

        ws.data.playerId = playerId;
        reclaimRoom.connections.register(playerId, ws);
        reclaimRoom.messages.handleHandshake(playerId, undefined, true);
        // Disconnect cancelled any pending respawn — if they come back dead,
        // re-arm it or the restored corpse stays dead forever
        reclaimRoom.messages.onPlayerReconnected(playerId);

        logger.info('Player reconnected within grace period, state restored', { playerId, room: reclaimRoom.name, health: existingPlayer.health, pos: existingPlayer.position });
        return;
      }

      logger.warn('Duplicate playerId rejected', { playerId });
      ws.close(1008, 'Player ID already connected');
      return;
    }

    const roomMode = typeof handshake.mode === 'string' && SessionManager.ROOM_NAME_RE.test(handshake.mode)
      ? handshake.mode
      : '';
    // Map/bots hints ride the join so a disposed quick-join room rebuilds
    // with the same spec — the room name alone doesn't carry it.
    const joinMap = typeof handshake.map === 'string' && SessionManager.ROOM_NAME_RE.test(handshake.map)
      ? handshake.map
      : '';
    const joinBots = typeof handshake.bots === 'number' && Number.isFinite(handshake.bots)
      ? Math.max(0, Math.min(24, Math.floor(handshake.bots)))
      : undefined;
    const room = this.d.roomFor(roomName, roomMode, joinMap, joinBots);

    // Watch-only join: `spectate: true` registers the socket for this
    // room's broadcasts + tick stream without spawning a player — no
    // roster entry, no team, no idle-reap, no slot in the match.
    if (handshake.spectate === true) {
      if (room.spectators.size >= CONFIG.maxPlayers) {
        ws.close(1013, 'Spectators full');
        return;
      }
      ws.data.playerId = playerId;
      room.spectators.add(playerId);
      this.d.specRooms.set(playerId, room);
      room.connections.register(playerId, ws);
      room.messages.handleSpectatorHandshake(playerId);
      this.d.ops.joins++;
      logger.info('Spectator joined', { playerId, room: room.name });
      return;
    }

    // Two caps: the room's own seat count and the process-wide budget —
    // rooms share one core, so total bodies is the number that matters
    // for latency, not per-room occupancy.
    if (room.playerCount() >= CONFIG.maxPlayers ||
        (CONFIG.globalMaxPlayers > 0 && this.d.totalPlayers() >= CONFIG.globalMaxPlayers)) {
      ws.close(1013, 'Server full');
      return;
    }

    // Claimed identity: a taken name needs its HMAC token, or the claimer
    // and the claimant get rejected — no stealing by knowing the id.
    const claimed = this.claimedIdentities.get(playerId);
    const idToken = this.identityToken(playerId);
    if (claimed && claimed !== token) {
      logger.warn('Join rejected: claimed playerId, bad token', { playerId });
      ws.close(1008, 'Player ID claimed');
      return;
    }
    if (!claimed) {
      if (this.claimedIdentities.size >= SessionManager.MAX_IDENTITIES) {
        // Map iterates insertion-ordered — dropping the first half evicts
        // the stalest claims in one pass.
        const it = this.claimedIdentities.keys();
        for (let i = 0; i < SessionManager.MAX_IDENTITIES / 2; i++) {
          const k = it.next().value;
          if (k === undefined) break;
          this.claimedIdentities.delete(k);
        }
      }
      this.claimedIdentities.set(playerId, idToken);
    }

    ws.data.playerId = playerId;
    const sessionToken = idToken;
    room.sessionTokens.set(playerId, sessionToken);
    const joinedPlayer = room.players.addPlayer(playerId, room.nextTeam(), isPerkId(handshake.perk) ? handshake.perk : 'none');
    if (handshake.transport === 'wt' || handshake.transport === 'rtc' || handshake.transport === 'ws') {
      joinedPlayer.transport = handshake.transport;
    }
    this.d.playerRoom.set(playerId, room);
    room.connections.register(playerId, ws);
    room.messages.handleHandshake(playerId, sessionToken);
    this.d.ops.joins++;
    switch (handshake.transport) {
      case 'ws': this.d.ops.tierWs++; break;
      case 'wt': this.d.ops.tierWt++; break;
      case 'rtc': this.d.ops.tierRtc++; break;
      default: this.d.ops.tierOther++;
    }

    logger.info('Player connected', { playerId, room: room.name, total: room.playerCount() });
  }
}
