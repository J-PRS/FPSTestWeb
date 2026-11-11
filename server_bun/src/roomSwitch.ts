/**
 * RoomSwitcher — mid-match room hops. Same socket, new membership: reuses
 * the leave teardown + SessionManager's join tail, so the fresh gameState
 * the new room emits drives the client's existing (re)connect rebuild and
 * the wire needs no new shape. Split out of GameServer so the dispatcher
 * stays about sockets while this owns seat transfers.
 */
import type { ServerWebSocket } from 'bun';
import type { WebSocketData,PlayerState } from './types.ts';
import type { Room } from './Room.ts';

import type { TransportKind, RoomMods } from '../../shared/protocol.ts';
import { roomModsOf } from '../../shared/protocol.ts';
import { evictEldest } from './evictEldest.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import { wallNow , wallMs} from './wallClock.ts';
import { roomWord as word } from './wire.ts';

export interface SwitchHost {
  roomOfPlayer(playerId: string): Room | undefined;
  roomFor(name: string, mode?: string, map?: string, bots?: number, mods?: RoomMods): Room | null;
  hasRoom(name: string): boolean;
  removePlayerCompletely(room: Room, playerId: string, reason: string): void;
  totalPlayers(): number;
  specRooms: Map<string, Room>;
  playerRoom: Map<string, Room>;
  sessions: { tokenFor(playerId: string): string };
  /** The session record rides the hop — a switch is a seat transfer,
   *  not a new connection. Without begin+seat the hopped player has no
   *  session: gen checks fail open and a later close is ignored. */
  registry: { begin(playerId: string, room: string): void; seat(playerId: string, spectator: boolean, reason: string): number; roomOf(playerId: string): string | undefined; retarget(playerId: string, room: string): boolean };
}

export class RoomSwitcher {
  // Switch-spam guard: reseating a session tears down/rebuilds a player
  // record plus two broadcasts — cheap per hop, but a 20Hz spammer would
  // churn two rooms' rosters for free. A short cooldown is plenty.
  private cooldowns = new Map<string, number>();
  private static readonly SWITCH_COOLDOWN_MS = 1500;

  constructor(private host: SwitchHost) {}

  switchRoom(ws: ServerWebSocket<WebSocketData>, playerId: string, raw: unknown): void {
    if (this.throttled(playerId)) {return;}

    // Hop FROM a still-connecting seat (first join deferred on
    // terrainReady): no roster entry to tear down — re-point the session
    // so the stale deferred seat dies on the roomOf check, then seat the
    // target when its field lands.
    // Mint gate mirrors the join path: untrusted traffic may hop into an
    // existing room, never conjure one (roomFor mints missing names).
    const mayMint = CONFIG.clientRooms || ws.data.trusted === true;
    if (!this.host.roomOfPlayer(playerId)) {
      const msg = raw as { room?: string; map?: string; mode?: string; bots?: number } & RoomMods;
      if (!mayMint && !this.host.hasRoom(word(msg.room) ?? 'default')) {return;}
      const to = this.host.roomFor(word(msg.room) ?? 'default', word(msg.mode) ?? '', word(msg.map) ?? '',
        typeof msg.bots === 'number' && Number.isFinite(msg.bots) ? Math.max(0, Math.min(24, Math.floor(msg.bots))) : undefined,
        roomModsOf(msg));
      if (!to || this.roomFull(to)) {return;}
      this.seatOnReady(to, ws, playerId, 'none', 'medium', undefined, undefined);
      logger.info('Pre-seat hop retargeted', { playerId, to: to.name });
      return;
    }

    const target = this.switchTarget(playerId, mayMint, raw as { room?: string; map?: string; mode?: string; bots?: number } & RoomMods);
    if (!target) {return;}
    const { from, to, prev } = target;

    // Leave teardown: the disconnect path minus the grace window.
    from.connections.unregister(playerId);
    from.rateLimiter.removePlayer(playerId);
    from.messages.onPlayerDisconnected(playerId);
    this.host.removePlayerCompletely(from, playerId, 'roomSwitch');

    this.seatOnReady(to, ws, playerId, prev?.perk ?? 'none', prev?.armorClass ?? 'medium', prev?.transport, prev?.name,
      // Banked respawn edits ride the hop — a hop is a seat transfer, not
      // a respawn, so a queued class/perk swap must survive it or the
      // client's declared next-life loadout silently vanishes. Applied
      // INSIDE the deferred seat: a terrain-loading room has no player
      // record until fire() runs, so patching it here dropped the kit.
      prev ? { pendingClass: prev.pendingClass, pendingPerk: prev.pendingPerk } as const : undefined);
    // Same gate check the join path sends — a host hopping into a
    // pre-existing room with different sim toggles must hear it.
    const req = roomModsOf(raw as RoomMods);
    const wantNoBalls = req.noBalls === true, wantNoCreatures = req.noCreatures === true, wantInsta = req.instagib === true;
    const toMods = to.mods;
    if ((toMods.noBalls === true) !== wantNoBalls || (toMods.noCreatures === true) !== wantNoCreatures || (toMods.instagib === true) !== wantInsta) {
      const diffs = [
        wantNoBalls === (toMods.noBalls === true) ? '' : `balls ${toMods.noBalls === true ? 'OFF' : 'ON'}`,
        wantNoCreatures === (toMods.noCreatures === true) ? '' : `critters ${toMods.noCreatures === true ? 'OFF' : 'ON'}`,
        wantInsta === (toMods.instagib === true) ? '' : `instagib ${toMods.instagib === true ? 'ON' : 'OFF'}`,
      ].filter(Boolean).join(', ');
      to.sendToPlayer(playerId, { type: 'serverWarn', text: `room '${to.name}' already existed — your settings overridden (${diffs})` });
    }
    logger.info('Player switched rooms', { playerId, from: from.name, to: to.name });
  }

  /** Everything that can deny a hop before teardown — null means the
   *  request dies here (with the client notified when it's worth it). */
  private switchTarget(playerId: string, mayMint: boolean, msg: { room?: string; map?: string; mode?: string; bots?: number } & RoomMods): { from: Room; to: Room; prev?: PlayerState } | null {
    const name = word(msg.room) ?? 'default';
    const from = this.host.roomOfPlayer(playerId);
    if (!from) {return null;}
    if (from.name === name) {return null;} // already seated — no-op, not an error

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
    if (!mayMint && !this.host.hasRoom(name)) {
      from.connections.sendToPlayer(playerId, { type: 'matchNotice', text: `no room '${name}'` });
      return null;
    }
    const to = this.host.roomFor(name, word(msg.mode) ?? '', word(msg.map) ?? '', bots, roomModsOf(msg));
    if (!to) {
      from.connections.sendToPlayer(playerId, { type: 'matchNotice', text: 'Server full — try again shortly' });
      return null;
    }
    if (this.roomFull(to)) {
      from.connections.sendToPlayer(playerId, { type: 'matchNotice', text: `${name} is full` });
      return null;
    }

    // The kit rides with the player — the hop isn't a loadout reset.
    return { from, to, prev: prev ?? undefined };
  }

  /** The join tail a room hop shares with SessionManager's accept path —
   *  token, roster entry, socket registration, handshake replay. */
  private seatPlayer(room: Room, ws: ServerWebSocket<WebSocketData>, playerId: string, perk: string, armorClass: string, transport?: TransportKind, name?: string, pending?: Pick<PlayerState, 'pendingClass' | 'pendingPerk'>): void {
    const sessionToken = this.host.sessions.tokenFor(playerId);
    room.sessionTokens.set(playerId, sessionToken);
    // Instagib rooms seat light-only - the hop carries the kit but the
    // modifier owns the chassis, and a banked class pick can't land.
    const insta = room.mods.instagib === true;
    const igun = room.mods.igun === true;
    const joined = room.players.addPlayer(playerId, room.nextTeam(), perk, insta ? 'light' : (igun ? 'medium' : armorClass));
    joined.name = name;
    if (transport) {joined.transport = transport;}
    if (pending) {
      joined.pendingClass = (insta || igun) ? undefined : pending.pendingClass;
      joined.pendingPerk = pending.pendingPerk;
    }
    // Room hops don't stop the client's stream: reports emitted in the
    // OLD room keep arriving for ~1 RTT and would poison the fresh
    // anchor (first straggler seats lastPosCheckPos, the post-hop spawn
    // report then reads as an impossible 100m+ jump). Mute the
    // plausibility gate + shadow judge for the same drain window a
    // correction gets.
    joined.correctionGraceUntil = wallMs(wallNow() + CONFIG.reportGraceMs);
    // removePlayerCompletely above reaped the session — the hop must
    // re-open it in the new room or the seat is session-less (stale gen
    // on the socket makes its later close a no-op → zombie player that
    // only idle-reap ever collects).
    ws.data.gen = this.host.registry.seat(playerId, false, 'roomSwitch');
    this.host.playerRoom.set(playerId, room);
    room.connections.register(playerId, ws);
    room.messages.handleHandshake(playerId, sessionToken);
    // The shadow is created inside handleHandshake — arm its drain
    // window after it exists.
    room.moveSim.markReseated(playerId);
  }

  /** Seat once the room's field exists — minted terrain rooms load
   *  async and seating before the field lands is the buried-spawn class
   *  (same gate as SessionManager's join deferral). Intent is set first:
   *  a second hop mid-wait, or a stale deferred join in another room,
   *  dies on the roomOf check instead of winning a registration race. */
  private seatOnReady(room: Room, ws: ServerWebSocket<WebSocketData>, playerId: string, perk: string, armorClass: string, transport?: TransportKind, name?: string, pending?: Pick<PlayerState, 'pendingClass' | 'pendingPerk'>): void {
    if (!this.host.registry.retarget(playerId, room.name)) {
      this.host.registry.begin(playerId, room.name);
    }
    const fire = (): void => this.seatPlayer(room, ws, playerId, perk, armorClass, transport, name, pending);
    if (room.terrainReady) {
      void room.terrainReady.then((): void => {
        if (ws.readyState === 1 && this.host.registry.roomOf(playerId) === room.name) {fire();}
      });
    } else {fire();}
  }

  private throttled(playerId: string): boolean {
    const now = wallNow();
    if (now - (this.cooldowns.get(playerId) ?? 0) < RoomSwitcher.SWITCH_COOLDOWN_MS) {return true;}
    // Mark on attempt — denied paths (room full, dead, no-op) stay
    // throttled too or switchRoom name-spam churns roomFor unbounded.
    this.cooldowns.set(playerId, now);
    // Server-lifetime map: hoppers keep their entry past removal (the
    // cooldown must survive the hop), so cap growth like duelStart —
    // evict the eldest, not clear(): a wholesale wipe under id churn
    // resets the cooldown for every live hopper at once.
    if (this.cooldowns.size > 1024) {evictEldest(this.cooldowns);}
    return false;
  }

  private roomFull(room: Room): boolean {
    // The global budget counts every fanout target — spectators draw the
    // same tick stream as players, so players + watchers together are
    // what the budget actually bounds.
    return room.playerCount() >= room.maxPlayers ||
      (CONFIG.globalMaxPlayers > 0 &&
        this.host.totalPlayers() + this.host.specRooms.size >= CONFIG.globalMaxPlayers);
  }
}
