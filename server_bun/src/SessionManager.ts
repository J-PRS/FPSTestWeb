import type { ServerWebSocket } from 'bun';
import { CONFIG } from './config.ts';
import type { Room } from './Room.ts';
import { validatePlayerId } from './validation.ts';
import type { PlayerState, WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { isPerkId } from '../../shared/perks.ts';
import type { SessionRegistry } from './sessionRegistry.ts';
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { wallNow } from './wallClock.ts';
import { simNow, simMs } from './simClock.ts';
import { windowAllow } from './windowLimit.ts';
import { roomWord } from './wire.ts';
import { roomModsOf, type RoomMods } from '../../shared/protocol.ts';

/** Everything the socket lifecycle needs from GameServer  -  supplied as
 *  closures/maps so ownership stays with the dispatcher. */
export interface SessionDeps {
  rooms: Map<string, Room>;
  /** playerId → room index for the hot paths (binary position 20Hz). */
  playerRoom: Map<string, Room>;
  /** Spectator sockets aren't players  -  roomOfPlayer can't find them. */
  specRooms: Map<string, Room>;
  roomFor(name: string, mode?: string, map?: string, bots?: number, mods?: RoomMods): Room | null;
  quickRoom(mode: string, map?: string, bots?: number, mods?: RoomMods, preferHumans?: boolean, mayMint?: boolean): Room | null;
  roomOfPlayer(playerId: string): Room | undefined;
  totalPlayers(): number;
  /** Drain-deploys: armed via /admin/drain  -  new joins refused (reclaims
   *  still land, they're the grace path), process exits on empty. */
  draining?: boolean;
  ops: { joins: number; tierWs: number; tierWt: number; tierRtc: number; tierOther: number;
    joinWaitMsSum: number; joinWaitMsMax: number; joinWorkMsSum: number; joinWorkMsMax: number; joinN: number };
  /** Session lifecycle state machine  -  owns who each playerId is; sockets
   *  carry the seat generation it stamps so stale callbacks die by gen. */
  registry: SessionRegistry;
  /** Single spectator exit path (GameServer.departSpectator)  -  roster,
   *  connection, specRooms index and session record die together. */
  departSpectator(playerId: string, reason: string, closeCode?: number): boolean;
  /** Full teardown of a player seat (roster + grace + indexes)  -  used by
   *  a different-room join to retire the stale seat before re-seating. */
  removePlayerCompletely(room: Room, playerId: string, reason: string): void;
}

/** Typed join fields extracted from the untyped handshake  -  shared by
 *  the reclaim gate, room resolution, and seat stages of handle(). */
interface JoinSpec {
  token: string | undefined; roomName: string; roomMode: string; joinMap: string; joinBots: number | undefined;
  resumeSeq: number | undefined; name: string | undefined;
  /** Creation-time room modifiers, normalized off the flat wire fields. */
  mods: RoomMods;
}

/** Join handshake + persistent identity. Handles four join shapes:
 *  session reclaim (grace-period reconnect), spectate, normal join, and
 *  every rejection path (throttle, caps, claimed ids, bad tokens). */
export class SessionManager {

  // Persistent identity: playerId → HMAC(playerId, secret). A claimed id
  // can't be taken without its token; tokens survive server restarts when
  // FPS_SECRET is set (random per boot otherwise  -  dev default).
  private identitySecret = CONFIG.identitySecret || randomBytes(32).toString('hex');
  private claimedIdentities = new Map<string, string>();
  // Unbounded by default  -  a join-spam botnet would otherwise grow this
  // map forever. Past the cap, evict oldest-first (insertion order).
  private static readonly MAX_IDENTITIES = 10_000;

  // Join throttle: ip → sliding window counters. Entries only reset when
  // that same IP joins again  -  unique-IP floods would grow the map
  // forever, so cap it like the other server-lifetime tables.
  private joinWindows = new Map<string, { count: number; start: number }>();
  private static readonly MAX_JOIN_WINDOWS = 1024;
  private static readonly RECONNECT_PROTECT_MS = 2500;
  /** Free reconnect shields per seat  -  honest flappers rarely reclaim
   *  more than twice in a seat's life; exploiters flap every 2.5s. */
  private static readonly MAX_RECLAIM_SHIELDS = 3;
  // 5/min rejected a whole household: every player behind one NAT/CGNAT
  // shares the bucket  -  a six-seat LAN or a tailnet's clients trip it on
  // their FIRST connect burst (or any flap storm minting fresh ids).
  // 20/min still stops the script-flood class this exists for.
  private static readonly JOIN_LIMIT = 20;
  private static readonly JOIN_WINDOW_MS = 60_000;

  constructor(private readonly d: SessionDeps) {}

  private joinThrottleAllow(ip: string): boolean {
    // Loopback is the dev box and the pvptest harness  -  fleets spawn 24+
    // joins/minute legitimately. Flood control is for real traffic only.
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {return true;}
    return windowAllow(
      this.joinWindows, ip, wallNow(),
      SessionManager.JOIN_WINDOW_MS, SessionManager.JOIN_LIMIT, SessionManager.MAX_JOIN_WINDOWS,
    );
  }

  private identityToken(playerId: string): string {
    return createHmac('sha256', this.identitySecret).update(playerId).digest('base64url');
  }

  /** Deterministic per-id token  -  a mid-match room switch re-seats the
   *  session in the new room, which needs the same token so a later
   *  disconnect+reclaim there still authenticates. */
  tokenFor(playerId: string): string {
    return this.identityToken(playerId);
  }

  handle(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    const handshake = this.handshakeGate(ws, raw);
    if (!handshake) {return;}
    const join = this.joinIdentity(ws, handshake);
    if (!join) {return;}
    const { playerId, spec } = join;
    if (this.reclaimHandled(ws, playerId, handshake, spec)) {return;}
    if (!this.joinAdmitted(ws, handshake)) {return;}
    const room = this.joinRoom(ws, playerId, handshake, spec);
    if (!room) {return;}
    this.seatJoiner(ws, room, playerId, handshake, spec);
  }

  /** Pre-join gate: malformed frames close 1008; volatile keepalives
   *  (ping/pong/clientStats/tickNack) are swallowed  -  a tier probe
   *  holds sends in a pending queue that flushes on session open, so
   *  pings enqueued during the probe land before join. Killing the
   *  session re-arms the reconnect loop (the ~1s flap storm); swallowing
   *  them costs nothing. */
  private handshakeGate(ws: ServerWebSocket<WebSocketData>, raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'object' || raw === null) {
      ws.close(1008, 'Invalid handshake');
      return null;
    }
    const handshake = raw as Record<string, unknown>;
    if (handshake.type === 'ping' || handshake.type === 'pong' || handshake.type === 'clientStats' || handshake.type === 'tickNack') {return null;}
    if (handshake.type !== 'join') {
      logger.warn('pre-join frame rejected', { got: handshake.type });
      ws.close(1008, 'Expected join handshake');
      return null;
    }
    // Join-phase mark: upgrade→dispatch wait  -  the inbound-queue and
    // loop-starvation component of first-gameState latency.
    const waitMs = wallNow() - ws.data.connectedAt;
    this.d.ops.joinWaitMsSum += waitMs;
    if (waitMs > this.d.ops.joinWaitMsMax) {this.d.ops.joinWaitMsMax = waitMs;}
    return handshake;
  }

  private joinIdentity(ws: ServerWebSocket<WebSocketData>, handshake: Record<string, unknown>): { playerId: string; spec: JoinSpec } | null {
    const playerIdResult = validatePlayerId(handshake.playerId);
    if (!playerIdResult.success) {
      logger.warn('Invalid playerId rejected', { error: playerIdResult.error });
      SessionManager.rejectIdentity(ws, 'Invalid playerId');
      return null;
    }
    return { playerId: playerIdResult.data, spec: SessionManager.joinSpec(handshake) };
  }

  /** Reclaim gate  -  returns true when the pipeline is done (seat
   *  reclaimed or join rejected), false to continue as a fresh join.
   *  A reclaim must land in the room the session was in  -  find by
   *  playerId rather than trusting the claimed room (reconnecting to a
   *  different room mid-grace would orphan the slot in the old room).
   *  Reclaims run BEFORE the join flood guard: a flapping transport
   *  reconnects through this path, and throttling it locks a legit
   *  player out of their own seat  -  reclaim is already authenticated
   *  by the session token. */
  private reclaimHandled(ws: ServerWebSocket<WebSocketData>, playerId: string, handshake: Record<string, unknown>, spec: JoinSpec): boolean {
    const { token, roomName, resumeSeq, mods } = spec;
    const noBalls = mods.noBalls === true, noCreatures = mods.noCreatures === true;
    const reclaimRoom = this.d.roomOfPlayer(playerId);
    // …but only for the SAME room: an explicit ?room=B while a grace seat
    // lingers in A is intent to move, not a flapping transport. Retire the
    // old seat now (one-seat-per-id is load-bearing  -  the lifecycle fuzz
    // enforces it) and fall through to a normal join in the new room.
    if (reclaimRoom && reclaimRoom.name !== roomName) {
      // Token gate BEFORE seat destruction: the join claims a different
      // room, so reclaim()'s own auth path never runs  -  without this a
      // bare playerId retires any live/grace seat on any room (grief-kick).
      // The client's stored token is the same id-keyed HMAC the seat holds.
      if (token !== reclaimRoom.sessionTokens.get(playerId)) {
        logger.warn('Different-room join rejected: bad token', { playerId, from: reclaimRoom.name, to: roomName });
        SessionManager.rejectIdentity(ws, 'Invalid session token');
        return true;
      }
      this.d.removePlayerCompletely(reclaimRoom, playerId, 'different-room join');
      logger.info('Different-room join retired grace seat', { playerId, from: reclaimRoom.name, to: roomName });
      return false;
    }
    if (!reclaimRoom) {return false;}
    const ok = this.reclaim(ws, reclaimRoom, playerId, token, resumeSeq, handshake);
    // Same post-gameState seat edge as a fresh join - restores the
    // stored rung (and roster weapon) the grace seat kept.
    if (ok) {reclaimRoom.gunGameSeat(playerId);}
    // Reclaim skips roomFor, so the joiner's sim gates would never be
    // consulted  -  a re-host with noBalls inside the grace window lands
    // in the stale spec anyway. When the room is otherwise bot-only
    // it's still theirs: adopt the flags like an empty-room join does.
    if (ok && reclaimRoom.players.getHumanCount() <= 1 &&
        ((reclaimRoom.mods.noBalls === true) !== noBalls || (reclaimRoom.mods.noCreatures === true) !== noCreatures)) {
      reclaimRoom.mods.noBalls = noBalls || undefined;
      reclaimRoom.mods.noCreatures = noCreatures || undefined;
      if (noCreatures) {reclaimRoom.creatureSim.pops = {}; reclaimRoom.creatureSim.cullAll();}
      if (noBalls) {reclaimRoom.ballSim.population = { base: 0, perPlayer: 0, max: 0 }; reclaimRoom.ballSim.cullAll();}
      logger.info('Reclaim adopted joiner sim gates', { room: reclaimRoom.name, noBalls, noCreatures });
    }
    return true;
  }

  /** Post-reclaim admission: drain check, ops-token trust stamp, then
   *  the join flood guard. Soak/test fleets all live behind one IP  - 
   *  a join carrying the ops admin token is a load driver, not a
   *  stranger: skip the flood guard. Same secret + compare as the ops
   *  routes (serverRoutes.tokEq). */
  private joinAdmitted(ws: ServerWebSocket<WebSocketData>, handshake: Record<string, unknown>): boolean {
    // Drain-deploy: a new build is live  -  refuse new seats but let
    // reclaims land (the grace path is how live players ride through).
    if (this.d.draining) { ws.close(1013, 'Server draining'); return false; }
    const trusted = typeof handshake.adminKey === 'string' && CONFIG.adminToken !== '' &&
      timingSafeEqual(createHash('sha256').update(handshake.adminKey).digest(), createHash('sha256').update(CONFIG.adminToken).digest());
    ws.data.trusted = trusted;
    // Join flood guard: joins bypass the per-player RateLimiter (they ARE
    // the registration), so throttle by source IP  -  5 joins/min is generous
    // for humans, lethal for a spammer script.
    // clientIp carries the XFF hop behind the local proxy  -  without it
    // every proxied join reads loopback and the flood guard never fires.
    const joinIp = ws.data.clientIp ?? ws.remoteAddress;
    if (!trusted && !this.joinThrottleAllow(joinIp)) {
      logger.warn('Join flood rejected', { ip: joinIp });
      ws.close(1013, 'Join rate limited');
      return false;
    }
    return true;
  }

  /** Room resolution + spectator/cap gates  -  null means the socket
   *  was closed or seated as a spectator (pipeline done either way).
   *  Bare link joins (/s|pub/<name>, no create params) must not mint
   *  rooms  -  a stale/shared name otherwise becomes an empty 'live'
   *  trap (the arena-1 class). Hosts create: their handshake carries
   *  map/mode/bots. Missing room + nothing to mint with = the
   *  matchmaker's busiest seat instead. Untrusted joins never mint: a
   *  name that doesn't exist (or a pick nothing reusable matched) lands
   *  in the busiest live room instead. Public deploys set
   *  FPS_CLIENT_ROOMS=0  -  the join flood's room-mint side-channel
   *  closes with the same gate. */
  private joinRoom(ws: ServerWebSocket<WebSocketData>, playerId: string, handshake: Record<string, unknown>, spec: JoinSpec): Room | null {
    const { roomName, roomMode, joinMap, joinBots, mods } = spec;
    const creates = joinMap !== '' || roomMode !== '' || joinBots !== undefined || mods.unlisted === true;
    const mayMint = CONFIG.clientRooms || ws.data.trusted === true;
    let room: Room | null;
    if (!creates && !this.d.rooms.has(roomName)) {
      room = this.d.quickRoom(roomMode, joinMap, joinBots, mods, true, mayMint);
    } else if (mayMint || this.d.rooms.has(roomName)) {
      room = this.d.roomFor(roomName, roomMode, joinMap, joinBots, mods);
    } else {
      room = null;
    }
    if (!room && !mayMint) {room = this.d.quickRoom('', '', undefined, mods, true, false);}
    if (!room) {
      ws.close(1013, 'Server full');
      return null;
    }

    // Watch-only join: `spectate: true` registers the socket for this
    // room's broadcasts + tick stream without spawning a player  -  no
    // roster entry, no team, no idle-reap, no slot in the match.
    if (handshake.spectate === true) {
      this.spectate(ws, room, playerId);
      return null;
    }

    if (!this.roomHasSeat(ws, room)) {return null;}
    return room;
  }

  /** Two caps: the room's own seat count and the process-wide budget  - 
   *  rooms share one core, so total bodies is the number that matters
   *  for latency, not per-room occupancy. Spectators draw the same tick
   *  stream as players, so they count against the budget too. */
  private roomHasSeat(ws: ServerWebSocket<WebSocketData>, room: Room): boolean {
    if (room.playerCount() >= room.maxPlayers ||
        (CONFIG.globalMaxPlayers > 0 &&
          this.d.totalPlayers() + this.d.specRooms.size >= CONFIG.globalMaxPlayers)) {
      ws.close(1013, 'Server full');
      return false;
    }
    return true;
  }

  /** Seat the joiner: claimed-identity check (a taken name needs its
   *  HMAC token, or the claimer and the claimant get rejected  -  no
   *  stealing by knowing the id), spectator eviction, session record,
   *  then the deferred finishJoin once the room's field is resident. */
  private seatJoiner(ws: ServerWebSocket<WebSocketData>, room: Room, playerId: string, handshake: Record<string, unknown>, spec: JoinSpec): void {
    const { token, roomMode, joinBots, name, mods } = spec;
    // Same-socket re-join for the same id is self-proving (the transport
    // endpoint was already validated)  -  a room hop issued before the first
    // gameState lands has no token yet and must not eat a reject.
    const idToken = this.identityToken(playerId);
    if (ws.data.playerId !== playerId && !this.claimIdentity(playerId, token, idToken)) {
      SessionManager.rejectIdentity(ws, 'Player ID claimed');
      return;
    }

    // A spectator id is squatters' rights, not a claim: a real join with
    // the same id must evict them or the message dispatcher keeps
    // treating the new player as read-only (specRooms is keyed by id,
    // not socket). Runs after claimIdentity  -  a rejected join shouldn't
    // kick the innocent spectator.
    // The spectator session ends here  -  the player session that follows
    // is a fresh generation, not a state transition.
    this.d.departSpectator(playerId, 'id claimed by player', 1008);

    ws.data.playerId = playerId;
    room.sessionTokens.set(playerId, idToken);
    // A hop before the first seat is a retarget, not a re-begin  -  no
    // lifecycle edge crossed, no anomaly counters to move.
    if (!this.d.registry.retarget(playerId, room.name)) {
      this.d.registry.begin(playerId, room.name);
    }
    const finishJoin = (): void => {
      this.seat(ws, room, playerId, handshake, idToken, name);
      // First joiner defined this room's sim gates AND its mode/bot roster  - 
      // (after seat(): the socket needs its connection registration first)
      // a hosted 'ctf 8 bots' request landing in a pre-existing room would
      // otherwise silently drop into someone else's match.
      const modeDiff = roomMode && room.mode !== roomMode ? `mode '${room.mode}'` : '';
      const botDiff = joinBots !== undefined && room.bots.count !== joinBots ? `${room.bots.count} bots` : '';
      const wantGG = mods.gungame === true, wantIG = mods.igun === true;
      const rm = room.mods;
      if ((rm.noBalls === true) !== (mods.noBalls === true) || (rm.noCreatures === true) !== (mods.noCreatures === true)
          || (rm.instagib === true) !== (mods.instagib === true)
          || (rm.gungame === true) !== wantGG || (rm.igun === true) !== wantIG || modeDiff || botDiff) {
        const diffs = [
          modeDiff,
          botDiff,
          (rm.noBalls === true) === (mods.noBalls === true) ? '' : `balls ${rm.noBalls === true ? 'OFF' : 'ON'}`,
          (rm.noCreatures === true) === (mods.noCreatures === true) ? '' : `critters ${rm.noCreatures === true ? 'OFF' : 'ON'}`,
          (rm.instagib === true) === (mods.instagib === true) ? '' : `instagib ${rm.instagib === true ? 'ON' : 'OFF'}`,
          (rm.gungame === true) === wantGG ? '' : `gungame ${rm.gungame === true ? 'ON' : 'OFF'}`,
          (rm.igun === true) === wantIG ? '' : `igun ${rm.igun === true ? 'ON' : 'OFF'}`,
        ].filter(Boolean).join(', ');
        room.sendToPlayer(playerId, { type: 'serverWarn', text: `room '${room.name}' already existed  -  your settings overridden (${diffs})` });
      }
    };
    // The spawn pick needs the room's real field  -  minted rooms load it
    // async. Seating on groundAt()=0 produces an authored anchor y under
    // the real surface: the buried-seat snap every first joiner paid.
    // The load is ms; defer rather than lift after the fact. A socket
    // that died in the gap doesn't seat  -  registering it leaves a ghost.
    // Same for a SUPERSEDED join: a room hop mid-load re-begins the
    // session under the new room; seating this socket into the old room
    // here would register it against the corpse  -  the zombie-seat race.
    if (room.terrainReady) {room.joinDone.set(playerId, room.terrainReady.then((): void => {
      if (ws.readyState === 1 && this.d.registry.roomOf(playerId) === room.name) {finishJoin();}
    }));}
    else {finishJoin();}
  }

  /** Grace-period reclaim: the seat is still reserved  -  cancel the removal
   *  timer and re-seat the socket, or reject on a bad token / live playerId. */
  private reclaim(ws: ServerWebSocket<WebSocketData>, room: Room, playerId: string, token: string | undefined, resumeSeq: number | undefined, handshake?: Record<string, unknown>): boolean {
    const existingPlayer = room.players.getPlayer(playerId);
    if (!existingPlayer) {
      logger.warn('Reclaim rejected: no player state', { playerId });
      SessionManager.rejectIdentity(ws, 'Invalid session token');
      return false;
    }
    // Session reclaim requires the server-issued token  -  bare playerId
    // knowledge must not be enough to steal a slot. Check it BEFORE the
    // disconnected test: a token holder is the slot's owner, and a zombie
    // socket whose close never landed must be evictable by them  -  the old
    // order rejected every reconnect as 'already connected' while the
    // stale close was still in flight (RTC SCTP shutdown can lag or be
    // lost entirely on a flap), looping the client forever.
    if (token !== room.sessionTokens.get(playerId)) {
      logger.warn('Reconnect rejected: bad session token', { playerId });
      SessionManager.rejectIdentity(ws, 'Invalid session token');
      return false;
    }
    // The armed grace timer clears inside registry.reclaim's transition  - 
    // no parallel bookkeeping survives from the old room map.
    // A valid-token reclaim IS liveness  -  without the stamp a seat that
    // spent >60s in grace gets idle-reaped before the first inputMove
    // lands, looping connect → reap → reconnect forever.
    existingPlayer.lastSeen = wallNow();
    const oldSock = room.connections.getConnection(playerId);
    ws.data.playerId = playerId;
    ws.data.gen = this.d.registry.reclaim(playerId, 'reclaim');
    room.connections.register(playerId, ws);
    // Offset-cursor replay: reliable events the dead socket missed stream
    // back BEFORE the handshake reply, so gameState remains the final word.
    if (resumeSeq !== undefined) {room.connections.replayTo(playerId, ws, resumeSeq);}
    // Evict whatever still held the seat  -  zombie or not. Register FIRST:
    // closing the old socket fires GameServer.onClose, which must see the
    // seat already owned by ws or it re-marks the player disconnected and
    // re-arms the removal timer under our live session.
    if (oldSock && oldSock !== ws) {
      try { oldSock.close(1000, 'replaced by reconnect'); } catch { /* gone */ }
    }
    room.markIntro(playerId); // reclaimer's decode baseline reset  -  fulls go to them only
    this.applyReclaimClaims(room, playerId, existingPlayer, handshake);
    room.messages.handleHandshake(playerId, undefined, true);
    // Disconnect cancelled any pending respawn  -  if they come back dead,
    // re-arm it or the restored corpse stays dead forever
    room.messages.onPlayerReconnected(playerId);
    // Same spawn-hold as a fresh join  -  only for seats that asked at
    // join (the flag lives on the player record) and only while ALIVE:
    // a corpse has nothing to veil (death already skips every funnel),
    // and holding a dead seat parks its respawn deadlines on the
    // awaitingReady gate — resync churn re-latching the hold wedges the
    // seat dead forever. Dead seats keep their respawn timer instead;
    // the revive gets the normal spawn shield.
    if (existingPlayer.spawnHold && !existingPlayer.isDead) {room.players.holdSpawn(playerId);}

    logger.info('Player reconnected within grace period, state restored', { playerId, room: room.name, health: existingPlayer.health, pos: existingPlayer.position });
    return true;
  }

  // The rejoiner's declared class must reconcile with the seat's  -  a
  // restart-restore blob only knows the dying session's class, so a
  // client whose kit banked a different tier reconnects holding weapons
  // the seat's class can't fire (class-locked rejects until death).
  // The reconnect is itself the declared discontinuity: apply now.
  // Perk same shape: the seat's blob perk vs the rejoiner's picked one.
  // Reconnect shield: the client warms its pipeline behind the session
  // veil before dropping the player in  -  the restored body must not be
  // killable during that window (visible mechanic, not hidden-gfx).
  // Capped per seat: a deliberate flap would otherwise chain free
  // invulnerability windows mid-fight.
  private applyReclaimClaims(room: Room, playerId: string, existingPlayer: PlayerState, handshake?: Record<string, unknown>): void {
    const claim = typeof handshake?.armorClass === 'string' ? handshake.armorClass : undefined;
    if (claim) {room.applyClaimedClass(playerId, claim);}
    const perk = typeof handshake?.perk === 'string' ? handshake.perk : undefined;
    if (perk) {room.applyClaimedPerk(playerId, perk);}
    const shields = (room.reclaimShields.get(playerId) ?? 0) + 1;
    room.reclaimShields.set(playerId, shields);
    if (shields <= SessionManager.MAX_RECLAIM_SHIELDS) {
      existingPlayer.protectedUntil = simMs(simNow() + SessionManager.RECONNECT_PROTECT_MS);
    }
  }

  /** Identity rejections (bad token, claimed id, malformed id): tell the
   *  client to drop its stored session, THEN close. The 1008 close code
   *  never reaches clients on the WT/RTC tiers  -  without the message a
   *  stale-token client reprobes and rejoins in a loop, spinning up a
   *  fresh room on every attempt. The small delay lets the reliable lane
   *  flush before the socket tears down. */
  private static rejectIdentity(ws: ServerWebSocket<WebSocketData>, reason: string): void {
    try { ws.send(JSON.stringify({ type: 'sessionRejected', reason })); } catch { /* half-dead lane */ }
    setTimeout((): void => { try { ws.close(1008, reason); } catch { /* gone */ } }, 25);
  }

  /** Spectator seating: broadcasts + tick stream only, no player slot. */
  private spectate(ws: ServerWebSocket<WebSocketData>, room: Room, playerId: string): void {
    if (room.spectators.size >= CONFIG.maxPlayers) {
      ws.close(1013, 'Spectators full');
      return;
    }
    // Every spectator is a tick-fanout target, so they ride the same
    // process budget as players  -  per-room cap alone would let a
    // watcher fleet across many rooms bypass it entirely.
    if (CONFIG.globalMaxPlayers > 0 &&
        this.d.totalPlayers() + this.d.specRooms.size >= CONFIG.globalMaxPlayers) {
      ws.close(1013, 'Server full');
      return;
    }
    // Re-spectating the same id must retire the old seat first  -  the
    // specRooms index repoints while the old room's spectators set would
    // keep the ghost (two rosters, one id, ticks fanning out to a stale
    // socket). Runs after the caps so a refused re-join doesn't cost
    // the id its existing seat.
    if (this.d.specRooms.has(playerId)) {
      this.d.departSpectator(playerId, 'spectator re-seated', 1008);
    }
    ws.data.playerId = playerId;
    this.d.registry.begin(playerId, room.name);
    ws.data.gen = this.d.registry.seat(playerId, true, 'spectate');
    room.spectators.add(playerId);
    this.d.specRooms.set(playerId, room);
    room.connections.register(playerId, ws);
    room.markIntro(playerId); // spectators decode from zero too
    room.messages.handleSpectatorHandshake(playerId);
this.d.ops.joins += 1;
    logger.info('Spectator joined', { playerId, room: room.name });
  }

  /** Field extraction  -  untyped handshake object → typed join fields.
   *  Map/bots hints ride the join so a disposed quick-join room rebuilds
   *  with the same spec  -  the room name alone doesn't carry it. */
  /** Display-name sanitize  -  the wire name rides gameState/playerJoined
   *  verbatim into DOM text nodes, so this only needs to kill control
   *  bytes and cap length (markup dies at textContent rendering). */
  private static nameSpec(v: unknown): string | undefined {
    if (typeof v !== 'string') {return undefined;}
    // Control bytes die, and so do unicode format chars  -  a bidi
    // override renders reversed text in scoreboard/chat (name
    // spoofing), zero-width chars make names invisible/impersonable.
    // eslint-disable-next-line no-control-regex -- intentional strip of C0/C1 + Cf
    const n = v.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return n || undefined;
  }

  private static joinSpec(handshake: Record<string, unknown>): JoinSpec {
    return {
      name: SessionManager.nameSpec(handshake.name),
      token: typeof handshake.token === 'string' ? handshake.token : undefined,
      roomName: roomWord(handshake.room) ?? 'default',
      roomMode: roomWord(handshake.mode) ?? '',
      joinMap: roomWord(handshake.map) ?? '',
      joinBots: typeof handshake.bots === 'number' && Number.isFinite(handshake.bots)
        ? Math.max(0, Math.min(24, Math.floor(handshake.bots)))
        : undefined,
      // Offset cursor (Socket.IO connection-state-recovery shape): the last
      // reliable-event seq the client processed  -  the reclaim replays what
      // its dead socket missed instead of resnapshotting blind.
      resumeSeq: typeof handshake.resumeSeq === 'number' && Number.isFinite(handshake.resumeSeq)
        ? Math.max(0, Math.floor(handshake.resumeSeq))
        : undefined,
      mods: roomModsOf(handshake as RoomMods),
    };
  }

  /** A taken name needs its HMAC token  -  no stealing by knowing the id.
   *  New claims evict the stalest half of the map when the cap hits
   *  (insertion-ordered iteration = oldest first). */
  private claimIdentity(playerId: string, token: string | undefined, idToken: string): boolean {
    const claimed = this.claimedIdentities.get(playerId);
    if (claimed) {
      if (claimed === token) {return true;}
      logger.warn('Join rejected: claimed playerId, bad token', { playerId });
      return false;
    }
    if (this.claimedIdentities.size >= SessionManager.MAX_IDENTITIES) {
      const it = this.claimedIdentities.keys();
      for (let i = 0; i < SessionManager.MAX_IDENTITIES / 2; i += 1) {
        const k = it.next().value;
        if (k === undefined) {break;}
        this.claimedIdentities.delete(k);
      }
    }
    this.claimedIdentities.set(playerId, idToken);
    return true;
  }

  /** The seat itself: player record, transport tag, indices, handshake
   *  reply, and the join/tier counters. */
  private seat(ws: ServerWebSocket<WebSocketData>, room: Room, playerId: string, handshake: Record<string, unknown>, sessionToken: string, name?: string): void {
    // Instagib: no class pick (light only), perk defaults jumpstart, and
    // an undeclared skill falls back to blink - picks still flow through
    // perkUpdate/skill claims like any other room.
    const insta = room.mods.instagib === true;
    const joinedPlayer = room.players.addPlayer(playerId, room.nextHumanTeam(),
      isPerkId(handshake.perk) && (!insta || handshake.perk !== 'none') ? handshake.perk : (insta ? 'jumpstart' : 'none'),
      insta ? 'light' : (room.mods.igun === true ? 'medium' : (typeof handshake.armorClass === 'string' ? handshake.armorClass : 'medium')));
    // The seat replaces a bot's ONLY when the join grew the big side  - 
    // a human landing on the short side already balanced the room, and
    // retiring there too would just un-swap it (the bug where every join
    // kept sides uneven: odd rooms could never reach even).
    const counts = room.players.teamCounts();
    const other = joinedPlayer.team === 'alpha' ? 'bravo' : 'alpha';
    if (joinedPlayer.team && counts[joinedPlayer.team] > counts[other]) {
      room.bots.retireWorst(joinedPlayer.team);
    }
    // Joins are a drift source too  -  a retiring bot or a counted seat can
    // still leave a lopsided room; bots absorb the swap, humans stay put.
    room.balanceTeams();
    joinedPlayer.name = name;
    if (typeof handshake.skill === 'string' && handshake.skill.length <= 16) {joinedPlayer.skill = handshake.skill;}
    else if (insta) {joinedPlayer.skill = 'blink';}
    joinedPlayer.spawnHold = handshake.spawnHold === true;
    if (handshake.transport === 'wt' || handshake.transport === 'rtc' || handshake.transport === 'ws') {
      joinedPlayer.transport = handshake.transport;
    }
    ws.data.gen = this.d.registry.seat(playerId, false, 'join');
    this.d.playerRoom.set(playerId, room);
    room.connections.register(playerId, ws);
    room.markIntro(playerId); // per-joiner full window  -  see Room.introPlayers
    const workT0 = wallNow();
    room.messages.handleHandshake(playerId, sessionToken);
    // After the handshake's gameState: the client's kit lock must exist
    // before the rung push lands or a reclaim's climb reads as rung 0.
    room.gunGameSeat(playerId);
    const workMs = wallNow() - workT0;
    this.d.ops.joinWorkMsSum += workMs;
    if (workMs > this.d.ops.joinWorkMsMax) {this.d.ops.joinWorkMsMax = workMs;}
    this.d.ops.joinN += 1;
    // Opt-in spawn hold: veil-equipped clients declare spawnHold and
    // their body stays out of the world until 'ready'  -  a body that
    // exists before the player can see is a free frag. The hand goes
    // after the handshake so gameState still ships the true (alive)
    // localPlayerState the veil warms on.
    if (joinedPlayer.spawnHold) {room.players.holdSpawn(playerId);}
this.d.ops.joins += 1;
    this.countTransportTier(handshake.transport);

    logger.info('Player connected', { playerId, room: room.name, total: room.playerCount() });
  }

  /** Transport-tier ops counter for the join. */
  private countTransportTier(transport: unknown): void {
    switch (transport) {
      case 'ws': {this.d.ops.tierWs += 1; break;
      }
      case 'wt': {this.d.ops.tierWt += 1; break;
      }
      case 'rtc': {this.d.ops.tierRtc += 1; break;
      }
      default: {this.d.ops.tierOther += 1;
      }
    }
  }
}
