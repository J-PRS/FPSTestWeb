// Inbound wire dispatch — the receive half of the wire seam.
//
// WireIn owns everything between "bytes/parsed frame arrive" and "world
// event fires": the handler table, the v3 wire-id roster + tick decode
// pool, and the per-room sequence watermarks (ev / tickSeq / hitSeq) that
// guard stale and re-delivered frames. What it does NOT own lives behind
// the host: NetworkManager keeps transport, the outbound claim/journal
// path, the remote-player roster store, and the onX event surface — the
// small host methods below are the whole back-channel.

import { ChildLogger } from '../core/Logger.js';
import {
  isWireFrame, decodeTickFrame, decodeBallSegment,
  WIRE_BALLSEG, SERVER_TICK_MS,
  type TickDecodePool,
} from '../../../shared/wire.js';
import {type ServerMessage, type TickUpdatePlayer, PROTOCOL_VERSION} from '../../../shared/protocol.js';
import { WeaponType } from '../../../shared/weapons.js';
import { WORLD_MODEL, verbForType, checkPacket, rowPatch } from '../../../shared/worldModel.js';
import type { RemotePlayerState,NetworkManager } from './NetworkManager.js';
import { claim as netProbeClaim } from '../debug/netProbe.js';
import { parityProbes } from '../game/parity.js';
import { rejectCensus, dedupCensus, dropCensus } from './claimLedger.js';

import { urlParams } from '../core/params.js';

const logger = new ChildLogger('Wire');

export class WireIn {
  /** v3 tick-frame roster: u16 -> playerId, fed by 'wireIds' events that
   *  always precede the first frame referencing them (same socket). */
  private readonly wireIds = new Map<number, string>();
  /** Decode slots reused every tick — upsert deep-fills roster vecs so
   *  rostered values never alias a slot (see decodeTickFrame pool docs). */
  private readonly tickPool: TickDecodePool = { slots: [], byId: new Map(), resolveId: (id): string | undefined => this.wireIds.get(id) };

  private lastTickSeq = -1; // highest server tickSeq applied — stale frames drop
  /** ?dropticks=N test hook — see the tick-path comment below. */
  private static dropEvery = Number(urlParams.get('dropticks') ?? 0) || 0;
  private static dropCounter = 0;
  /** Last processed reliable `ev` seq — the host presents it as
   *  resumeSeq on a token-carrying join so the server replays only the
   *  missed frames. */
  private lastEv = 0;
  /** Reconnect grace lets the server replay in-flight playerHit events —
   *  seq is per-room monotonic so a stale re-delivery can't double-apply.
   *  Reset on disconnect/gameState: a new room's seq restarts at 1, and a
   *  retained high watermark would silently drop every hit for the whole
   *  session — the "half my damage instances don't work" desync. */
  private lastHitSeq = 0;

  /** Ring of recent health-affecting events — read by the desync dump so a
   *  hash mismatch says WHICH event diverged, not just that one did. */
  private readonly recentHealthEvents: { type: string; t: number; detail: string }[] = [];
  private static readonly HEALTH_EVENT_TYPES = new Set(['playerHit', 'playerKill', 'playerRespawn', 'buff', 'heal']);

  constructor(private readonly h: NetworkManager) {}

  /** Reliable-side watermark for the join handshake's resumeSeq. */
  get evWatermark(): number { return this.lastEv; }

  /** Highest server tickSeq applied — e2e probes poll it as the
   *  "binary lane alive" signal. */
  get tickSeq(): number { return this.lastTickSeq; }
  /** Wire handlers that threw mid-message (contained, counted — see dispatch). */
  handlerThrows = 0;

  recentEvents(): readonly { type: string; t: number; detail: string }[] {
    return this.recentHealthEvents;
  }

  /** A disconnect starts fresh per-room seq spaces — a retained high
   *  watermark would silently drop every hit/tick of the next session. */
  resetForReconnect(): void {
    this.lastTickSeq = -1;
    this.lastHitSeq = 0;
  }

  /** Wire-feed seam — one message through the live dispatch path, so
   *  recorded streams (.rec replays) and sockets are indistinguishable. */
  dispatch(data: ServerMessage | Uint8Array): void {
    if (typeof data === 'object' && !(data instanceof Uint8Array)) {this.message(data);}
    else {this.binary(data as Uint8Array);}
  }

  /** Inbound that lands before the app binds its handler deps (the
   *  `h.*` hooks fill in during wireNetworkHandlers) queues here — the
   *  socket is opened at boot start to overlap the handshake with
   *  init, and a worldstate hitting unbound hooks would desync
   *  silently. Flushed through the normal dispatch on markReady. */
  private early: (ServerMessage | Uint8Array)[] = [];
  private ready = true; // boot arms the queue only for the early-connect window
  private earlyDrops = 0;

  /** Wall-clock stamps per lane — reliable JSON events and binary ticks
   *  ride separately drainable pipes (WT stream-0 vs datagram/stream-2).
   *  A seat can lose one without the other; the stall watchdog reads
   *  these to catch a seat that gets ticks but no events (dead JSON
   *  lane → hits/kills/spawns silently gone). */
  lastJsonRxAt = 0;
  lastBinRxAt = 0;
  /** Any inbound EXCEPT inputSync — which is the server's starvation
   *  signal, not proof of life: a zombie seat that only gets inputSync
   *  trickles is dead (soak: 75s of inputSync with zero ticks/events —
   *  it kept resetting the liveness clock so the plain watchdog never
   *  fired). */
  lastLiveRxAt = 0;

  armEarlyQueue(): void { this.ready = false; }

  markReady(): void {
    this.ready = true;
    const q = this.early;
    this.early = [];
    if (this.earlyDrops > 0) {logger.warn(`wireIn dropped ${this.earlyDrops} early messages over the 512 cap`);}
    for (const m of q) {this.dispatch(m);}
  }

  private gate(data: ServerMessage | Uint8Array): boolean {
    if (this.ready) {return false;}
    if (this.early.length < 512) {this.early.push(data);}
    else {this.earlyDrops += 1;}
    return true;
  }

  message(data: ServerMessage, bytes?: number): void {
    if (this.gate(data)) {return;}
    // inputSync doesn't count as lane health — the server sends it when
    // OUR uplink looks starved, so it's literally the symptom marker of
    // the split-lane failure (a dead reliable lane saw only inputSync for
    // 75s in soak). Everything else — pings, hashes, events — stamps.
    if (data.type !== 'inputSync') {this.lastJsonRxAt = Date.now(); this.lastLiveRxAt = Date.now(); this.h.resetJsonLaneCounter();}
    parityProbes.msgSeen[data.type] = (parityProbes.msgSeen[data.type] ?? 0) + 1;
    // Rx is an approximation anyway — re-stringifying every event just to
    // size it cost a full second pass over reclaim replays (a 1024-frame
    // burst arrived as one giant main-thread task).
    this.h.noteRx(bytes ?? 256);
    // Offset cursor: every reliable frame carries a room-scoped `ev`.
    // Replays only ever carry seq > our watermark, so tracking the max
    // doubles as the dup guard if a transport ever re-delivers.
    const {ev} = (data as ServerMessage & { ev?: number });
    if (ev !== undefined && ev > this.lastEv) {this.lastEv = ev;}
    // Capture the server-issued session token for future reconnects.
    // gameState also re-seeds the ev watermark: `ev` is room-scoped, so a
    // room hop or fresh join must adopt THIS room's seq, not max() against
    // a stale watermark from the old room.
    if (data?.type === 'gameState') {
      if (ev !== undefined) {this.lastEv = ev;}
      if (typeof data.sessionToken === 'string') {this.h.acceptSessionToken(data.sessionToken);}
    }
    if (WireIn.HEALTH_EVENT_TYPES.has(data.type)) {
      if (this.recentHealthEvents.length >= 24) {this.recentHealthEvents.shift();}
      const d = data as Record<string, unknown>;
      this.recentHealthEvents.push({ type: data.type, t: Date.now(), detail: `${d.shooterId ?? d.playerId ?? ''}→${d.targetId ?? ''} ${d.damage ?? ''}` });
    }
    // Declared entity verbs get the inbound field check — a packet that
    // drops a declared field warns here instead of desyncing silently.
    const decl = verbForType(data.type);
    if (decl) {checkPacket(decl.kind, decl.verb, data as unknown as Record<string, unknown>);}
    // Avoid JSON.stringify on every message — tickUpdate arrives at 20Hz
    const handler = this.handlers[data.type] as ((d: ServerMessage) => void) | undefined;
    if (handler) {
      // A malformed-but-parseable message mustn't reach the connection's
      // onError path — one bad packet shouldn't cost a reconnect.
      try { handler(data); }
      catch (error) {
        // Swallow containment isn't free: the handler may have half-applied
        // state. The count surfaces in the Alt+Q dump so "feels off" reports
        // can be checked for silent partial-apply storms.
this.handlerThrows += 1;
        logger.warn(`Handler threw for ${data.type}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
    } else {
      logger.warn(`Unknown message type: ${data.type}`);
    }
  }

  binary(data: Uint8Array): void {
    if (this.gate(data)) {return;}
    this.lastBinRxAt = Date.now();
    this.lastLiveRxAt = Date.now();
    this.h.noteRx(data.length);
    if (!isWireFrame(data)) {
      logger.debug(`Received non-wire binary message: ${data.length} bytes`);
      return;
    }
    // Binary ball segments decode straight into the JSON message's shape —
    // netBallSegment sees one type regardless of transport.
    if (data[1] === WIRE_BALLSEG) {
      const seg = decodeBallSegment(data);
      if (seg) {
        // The frame decodes to flat scalars — the declared updateFields
        // own which ones cross into the JSON shape handlers see.
        const src = seg as unknown as Record<string, unknown>;
        const msg: Record<string, unknown> = { type: 'ballSegment', id: seg.id };
        for (const f of WORLD_MODEL.ball!.updateFields!) {msg[f.name] = src[f.name];}
        try { this.h.onBallSegment?.(msg as unknown as Extract<ServerMessage, { type: 'ballSegment' }>); }
        catch (error) {this.handlerThrows += 1; logger.warn(`Handler threw for ballSegment: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`); }
      }
      return;
    }
    // Stale-drop BEFORE decode: v4 decode mutates the byId baseline — an
    // out-of-order datagram frame would smuggle its stale fields into the
    // retained slots even when dropped here. tickSeq sits at bytes 6-9.
    if (data.byteLength >= 15 && new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(6, true) <= this.lastTickSeq) {return;}
    // ?dropticks=N — drop every Nth tick frame before decode to exercise
    // the tickNack recovery loop (localhost can't produce real loss).
    if (WireIn.dropEvery > 0 && (WireIn.dropCounter += 1) >= WireIn.dropEvery) { WireIn.dropCounter = 0; return; }
    const tick = decodeTickFrame(data, this.tickPool);
    if (!tick) {return;}
    // A real loss (the <= drop above already ate reorders): masked fields
    // in the gap are stale until each wireId's staggered full lands —
    // ask for a full-record window instead of waiting out the ~750ms.
    // Only count a gap on an ESTABLISHED stream (lastTickSeq >= 0): the
    // first frame after join/reset starts mid-room-seq, which is not a
    // loss — it used to count thousands of phantom misses into seqWindow
    // (100% packetLoss for the session's first 5s) and nack a burst the
    // roster-intro fulls already cover.
    if (this.lastTickSeq >= 0 && tick.tickSeq - this.lastTickSeq > 1) {this.h.onTickGap?.(tick.tickSeq - this.lastTickSeq - 1);}
    this.lastTickSeq = tick.tickSeq;
    // Same containment as the JSON path — a throwing tick handler at 20Hz
    // would otherwise hit onError and reconnect the socket every frame.
    try { this.handleTickUpdate(tick); }
    catch (error) {this.handlerThrows += 1; logger.warn(`Handler threw for tickUpdate: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`); }
  }

  private readonly handlers: { [K in ServerMessage['type']]: (data: Extract<ServerMessage, { type: K }>) => void } = {
    gameState: (data): void => this.handleGameState(data),
    tickUpdate: (data): void => this.handleTickUpdate(data),
    playerJoined: (data): void => this.handlePlayerJoined(data),
    playerLeft: (data): void => this.handlePlayerLeft(data),
    wireIds: (data): void => {
      for (const [idS, pid] of Object.entries(data.add)) {
        const id = Number(idS);
        // A re-seat without a matching remove must still drop the prior
        // owner's decode baseline — deltas can't decode against it.
        if (this.wireIds.has(id)) {this.tickPool.byId?.delete(id);}
        this.wireIds.set(id, pid);
      }
      for (const id of data.remove ?? []) {
        this.wireIds.delete(id);
        // A reissued id must seat a fresh baseline — never inherit the
        // departed owner's retained fields (see WireIdRoster.feed).
        this.tickPool.byId?.delete(id);
      }
    },
    teamUpdate: (data): void => { this.h.patchRemotePlayer(data.playerId, { team: data.team }); },
    playerHeld: (data): void => { this.h.patchRemotePlayer(data.playerId, { held: data.n }); this.h.onPlayerHeld?.(data.playerId, data.n); },
    playerRespawn: (data): void => this.handlePlayerRespawn(data),
    playerHit: (data): void => this.handlePlayerHit(data),
    buff: (data): void | undefined => this.h.onBuff?.(data),
    yourHealth: (data): void | undefined => this.h.onYourHealth?.(data.health, data.armor),
    yourCharge: (data): void | undefined => this.h.onYourCharge?.(data.charge),
    playerKill: (data): void => this.handlePlayerKill(data),
    knockback: (data): void | undefined => this.h.onKnockback?.(data.position, data.force, data.pull, data.yank),
    jump: (data): void | undefined => this.h.onPlayerJump?.(data.playerId, data.position),
    jetpack: (data): void | undefined => this.h.onPlayerJetpack?.(data.playerId, data.position),
    projectileCreated: (data): void | undefined => this.h.onProjectileCreated?.(data.projectileId, data.ownerId, data.position, data.velocity, data.weaponType, data.shotId, data.pellet),
    playerShot: (data): void | undefined => this.h.onPlayerShot?.(data.id, data.weaponType, data.pos, data.dir),
    projectileDestroyed: (data): void | undefined => this.h.onProjectileDestroyed?.(data.projectileId, data.shotId, data.position ?? undefined),
    snapshot: (data): void | undefined => this.h.onSnapshot?.(data.players || [], data.timestamp || Date.now()),
    stateHash: (data): void | undefined => this.h.onStateHash?.(data.hash, data.tick, data.playerCount, data.timestamp, data.replica),
    correction: (data): void => this.h.handleCorrection(data),
    inputSync: (data): void => this.h.resendInputs(data.lastSeq),
    claimAck: (data): void => this.h.ackClaim(data),
    teleport: (data): void | undefined => this.h.onRemoteTeleport?.(data.playerId, data.position, data.velocity),
    ballSpawn: (data): void | undefined => this.h.onBallSpawn?.(data),
    ballSegment: (data): void | undefined => this.h.onBallSegment?.(data),
    ballDie: (data): void | undefined => this.h.onBallDie?.(data),
    ballRoster: (data): void | undefined => this.h.onBallRoster?.(data),
    crawlSpawn: (data): void | undefined => this.h.onCrawlSpawn?.(data),
    crawlEvt: (data): void | undefined => this.h.onCrawlEvt?.(data),
    crawlDie: (data): void | undefined => this.h.onCrawlDie?.(data),
    crawlRoster: (data): void | undefined => this.h.onCrawlRoster?.(data),
    // Server-issued RTT probe — echo it back untouched so the server
    // measures round-trip itself instead of trusting our reported ping.
    ping: (data): void => this.h.pingReceived(data.timestamp),
    pong: (data): void => this.h.pongReceived(data.timestamp),
    srvPing: (data): void => { this.h.serverPingMs = typeof data.rtt === 'number' ? data.rtt : null; },
    chat: (data): void | undefined => this.h.onChat?.(data.playerId, data.text, data.team === true, typeof data.vgs === 'string' ? data.vgs : undefined, data.muted === true),
    flagUpdate: (data): void | undefined => this.h.onFlagUpdate?.(data.flags),
    nodeUpdate: (data): void | undefined => this.h.onNodeUpdate?.(data.nodes),
    matchNotice: (data): void | undefined => this.h.onMatchNotice?.(data.text, data),
    serverWarn: (data): void | undefined => this.h.onServerWarn?.(data.text),
    // WT/RTC path of the 1008 identity reject — the close code is lost
    // on those tiers, so the server sends this before closing.
    sessionRejected: (data): void => this.h.rejectSession(data.reason),
    pickupSpawn: (data): void | undefined => this.h.onPickupSpawn?.(data.id, data.pos, data.kind, data.val, data.vel),
    pickupGone: (data): void | undefined => this.h.onPickupGone?.(data.id, data.by ?? null),
    teamScore: (data): void | undefined => this.h.onTeamScore?.(data.scores, data.winAt),
    ffaScore: (data): void | undefined => this.h.onFfaScore?.(data.scores, data.winAt),
    ffaMatchEnd: (data): void | undefined => this.h.onFfaMatchEnd?.(data.winner, data.scores),
    matchEnd: (data): void | undefined => this.h.onMatchEnd?.(data.winner, data.scores),
    matchStart: (data): void | undefined => this.h.onMatchStart?.(data.mode, data.scores),
    matchToken: (data): void | undefined => this.h.onMatchToken?.(data.token),
    mapUpdate: (data): void | undefined => this.h.onMapUpdate?.(data),
    projRide: (data): void | undefined => this.h.onProjRide?.(data.projectileId, data.host),
    deploySpawn: (data): void | undefined => this.h.onDeploySpawn?.(data.id, data.owner, data.kind, data.pos, data.team),
    deployGone: (data): void | undefined => this.h.onDeployGone?.(data.id),
    deployDown: (data): void | undefined => this.h.onDeployDown?.(data.id, data.kind, data.team, data.respawnS),
    deployUp: (data): void | undefined => this.h.onDeployUp?.(data.id),
    sensorPing: (data): void | undefined => this.h.onSensorPing?.(data.id, data.team, data.targets),
    turretShot: (data): void | undefined => this.h.onTurretShot?.(data.id, data.owner, data.targetId),
    sentryShot: (data): void | undefined => this.h.onSentryShot?.(data.id, data.owner, data.x, data.y, data.z),
    mortarShot: (data): void | undefined => this.h.onMortarShot?.(data.id, data.owner, data.vx, data.vy, data.vz),
    mineBoom: (data): void | undefined => this.h.onMineBoom?.(data.id, data.pos),
    landed: (data): void | undefined => this.h.onLanded?.(data.playerId, data.pos, data.impact),
    deployHp: (data): void | undefined => this.h.onDeployHp?.(data.id, data.hp, data.armor, data.src),
    // Server refused a hit claim — worth surfacing: a healthy client
    // should basically never see this, so it's a desync tell.
    shotRejected: (data): void => {
rejectCensus.total += 1;
      rejectCensus.byReason.set(data.reason, (rejectCensus.byReason.get(data.reason) ?? 0) + 1);
      rejectCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) {this.h.confirmClaimHit(data.targetId ?? '', data.shotId);}
      const wName = data.weaponType === undefined ? undefined : String(WeaponType[data.weaponType] ?? data.weaponType);
      netProbeClaim('reject', data.reason, wName, data.targetId, this.h.getPing());
      logger.error(`shot rejected — predicted damage never applied`, {
        reason: data.reason,
        targetId: data.targetId,
        weapon: wName,
        pingMs: this.h.getPing(),
      });
      this.h.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health);
    },
    // Honest-lag discard (dead shooter/target) — not a reject, but the
    // predicted hit still needs clearing or the ledger warns phantom.
    claimDropped: (data): void => {
dropCensus.total += 1;
      dropCensus.byReason.set(data.reason, (dropCensus.byReason.get(data.reason) ?? 0) + 1);
      dropCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) {this.h.confirmClaimHit(data.targetId ?? '', data.shotId);}
      netProbeClaim('drop', data.reason, data.weaponType === undefined ? undefined : String(WeaponType[data.weaponType] ?? data.weaponType), data.targetId, this.h.getPing());
      logger.warn(`claim dropped — predicted damage never applied`, {
        reason: data.reason, targetId: data.targetId,
        weapon: data.weaponType === undefined ? undefined : WeaponType[data.weaponType] ?? data.weaponType,
        pingMs: this.h.getPing(),
      });
      this.h.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health);
    },
  };

  private handleGameState(data: Extract<ServerMessage, { type: 'gameState' }>): void {
    // Protocol handshake: a stale bundle can't parse a new wire format —
    // force-reload once (cache-busted) instead of silently desyncing. The
    // sessionStorage counter caps it at 2 attempts so a genuinely newer
    // server can't reload-loop the tab.
    // A new gameState means a new room instance — both seq spaces
    // restart at 1 (hitSeq and tickSeq are per-room), so the prior
    // room's high watermarks must not gate it. A room hop without
    // reconnect would otherwise freeze every remote for the session.
    this.lastHitSeq = 0;
    this.lastTickSeq = -1;
    this.h.dropClaims(false);
    this.h.clearResyncQuiet(); // truth landed — position claims are judged fresh
    const serverProto = data.protocolVersion ?? 0;
    if (serverProto !== PROTOCOL_VERSION) {
      // Storage can throw (private mode / disabled embeds) — treat a dead
      // counter as budget spent: warn + bail, never crash the handler.
      let tries = 2;
      try { tries = Number(sessionStorage.getItem('fps-proto-reload') ?? '0'); } catch { /* fall through */ }
      logger.warn(`Protocol mismatch: client=${PROTOCOL_VERSION} server=${serverProto} (attempt ${tries + 1})`);
      // Browser-only escape: headless harnesses (vitest, e2e replays) have
      // no location to reload — they get the warn + early return only.
      if (tries < 2 && typeof location !== 'undefined') {
        try {
          sessionStorage.setItem('fps-proto-reload', String(tries + 1));
          const url = new URL(window.location.href);
          url.searchParams.set('pv', String(Date.now())); // cache-buster vs CDN staleness
          window.location.href = url.toString();
        } catch { /* storage/nav both optional — warn already logged */ }
      } else if (typeof location !== 'undefined') {
        // Budget spent — a live socket with remotes frozen forever reads as
        // "game is broken", not "stale build". Close it so the normal
        // disconnect UI can name the failure. (Harnesses without a location
        // keep the warn + return.)
        this.h.disconnect();
      }
      return;
    }
    try { sessionStorage.removeItem('fps-proto-reload'); } catch { /* no budget to reset */ } // clean connect — reset the budget

    // gameState is the authoritative roster on (re)connect — clear stale
    // entries for players who left during our disconnect, then add the
    // current set. v3 ids are per-room: the snapshot replaces, not merges.
    this.wireIds.clear();
    // v4 masked deltas inherit per-wireId state — a new room epoch must
    // not let a reassigned id keep the old player's last-decoded fields.
    this.tickPool.byId?.clear();
    if (data.wireIds) {for (const [id, pid] of Object.entries(data.wireIds)) {this.wireIds.set(Number(id), pid);}}
    this.h.remoteReset(data.players);
    logger.debug(`raw gameState map: ${data.map ? JSON.stringify(data.map).slice(0, 300) : 'none'}`);
    this.h.onGameState?.(data.players || [], data.localPlayerState, { room: data.room, mode: data.mode, mapName: data.mapName, team: data.team, scores: data.scores, ffaScores: data.ffaScores, pickups: data.pickups, flags: data.flags, matchEndsAt: data.matchEndsAt, respawnMs: data.respawnMs, deployables: data.deployables, map: data.map });
  }

  private handleTickUpdate(data: { updates: TickUpdatePlayer[]; count?: number; ackSeq?: number; inputAck?: number; tickSeq?: number }): void {
    this.h.tickArrived();
    // Batched player updates from server (delta compressed)
    if (data.ackSeq !== undefined && data.ackSeq > 0) {
      this.h.ackPositionSeq(data.ackSeq);
    }
    // Tick-set confirm: the server consumed inputs ≤ inputAck — those
    // journal entries are dead weight and only matter to replay.
    if (data.inputAck !== undefined && data.inputAck > 0) {
      this.h.ackInputs(data.inputAck);
    }
    if (!data.updates || !Array.isArray(data.updates)) {return;}
    const now = Date.now();
    // Snapshots must carry the SERVER timeline (tickSeq×50), not arrival
    // wall time — arrival stamps fold transport jitter into the rendered
    // path itself, which is the rubberband mechanism. The JSON path has
    // no tickSeq and keeps the arrival fallback (host/loopback: jitter≈0).
    const serverMs = data.tickSeq === undefined ? now : data.tickSeq * SERVER_TICK_MS;
    // Pooled decode hands back its whole slots array + a live count —
    // entries past it are stale from earlier, larger frames.
    const n = Math.min(data.count ?? data.updates.length, data.updates.length);
    for (let i = 0; i < n; i += 1) {
      const u = data.updates[i]!; // n is clamped to updates.length above
      // v3 record ahead of its roster — can't build a body without an
      // identity, so it drops; the next record for that id resolves.
      if (!u.playerId) {continue;}
      this.applyTickPlayerUpdate(u, serverMs);
    }
  }

  // Scratch patch reused per record — one fresh object per remote per
  // 20Hz tick was the last steady-state alloc on this path. Every
  // declared field is overwritten each call (absent → undefined), and
  // upsert's `??` merge treats undefined as "keep stored", so a stale
  // key can never leak a previous row's value.
  private readonly tickPatch: Record<string, unknown> = {};

  private applyTickPlayerUpdate(u: TickUpdatePlayer, serverMs: number): void {
    // Defense-in-depth: server already excludes self from tickUpdate,
    // but skip local player here too in case of any server-side regression
    if (u.playerId === this.h.getLocalPlayerId()) {return;}
    const patch = this.tickPatch as Partial<RemotePlayerState>;
    for (const f of WORLD_MODEL.player.updateFields!) {
      const v = (u as unknown as Record<string, unknown>)[f.name];
      (patch as Record<string, unknown>)[f.name] = (v === undefined || v === null || v === '') ? undefined : v;
    }
    patch.internalId = u.internalId || undefined;
    this.h.upsertRemotePlayer(u.playerId, patch);
    this.h.onPlayerUpdate?.(u.playerId, u.position, u.rotation, serverMs, u.velocity);
  }

  private handlePlayerJoined(data: Extract<ServerMessage, { type: 'playerJoined' }>): void {
    // Rejoins (grace-period reconnects) re-broadcast playerJoined — only the
    // FIRST sighting is a roster event. Upserting health/isDead on a rejoin
    // would stomp the server-truth values tickUpdate already delivered, and
    // re-firing onPlayerJoined spam-recreates/logs the remote every time.
    const isNew = !this.h.remoteHas(data.playerId);
    const patch = rowPatch(WORLD_MODEL.player.spawnFields!, data as unknown as Record<string, unknown>) as Partial<RemotePlayerState>;
    // Rejoins get identity fields but not vitals — a grace rejoiner
    // keeps the wounded/dead truth tickUpdate already delivered.
    if (isNew) {patch.velocity = { x: 0, y: 0, z: 0 };}
    else { delete patch.health; delete patch.isDead; }
    if (patch.health !== undefined && !Number.isFinite(patch.health)) {delete patch.health;}
    this.h.upsertRemotePlayer(data.playerId, patch);
    if (isNew) {this.h.onPlayerJoined?.(data.playerId, data.position, data.rotation);}
  }

  private handlePlayerLeft(data: Extract<ServerMessage, { type: 'playerLeft' }>): void {
    if (data.playerId) {this.h.remoteDelete(data.playerId);}
    this.h.onPlayerLeft?.(data.playerId);
  }

  private handlePlayerRespawn(data: Extract<ServerMessage, { type: 'playerRespawn' }>): void {
    // Update REMOTE player in storage (local player respawn handled by callback)
    if (data.position) {
      this.h.upsertRemotePlayer(data.playerId, Object.assign({}, (rowPatch(WORLD_MODEL.player.events!.playerRespawn!, data as unknown as Record<string, unknown>) as Partial<RemotePlayerState>), {velocity: { x: 0, y: 0, z: 0 },isDead: false,health: data.health ?? 100}));
    }
    this.h.onPlayerRespawn?.(data.playerId, data.position, data.rotation, data.armorClass);
  }

  private handlePlayerHit(data: Extract<ServerMessage, { type: 'playerHit' }>): void {
    // Ghost-delta surface: the server credited this hit on a rewind ghost
    // >1.5m off the victim's live truth — the "hit where nobody stood"
    // feel, named on the shooter's HUD via the complaint feed.
    if (data.gd != null && data.shooterId === this.h.getLocalPlayerId()) {
      logger.warn(`ghost hit on ${data.targetId} — credited ${data.gd}m behind the live body`, { gd: data.gd });
    }
    if (data.shooterId === this.h.getLocalPlayerId()) {this.h.confirmClaimHit(data.targetId);}
    if (data.seq !== undefined) {
      if (data.seq <= this.lastHitSeq) {
dedupCensus.hitSeqDrops += 1;
        logger.warn(`playerHit dropped as stale seq ${data.seq} <= ${this.lastHitSeq}`);
        return;
      }
      this.lastHitSeq = data.seq;
    }
    // Update REMOTE player health in storage (local player health handled
    // by callback). A processed hit also proves the server holds the target
    // alive — it never lands a hit on a dead player — so a record still
    // marked dead from a lost respawn edge un-sticks here instead of
    // waiting for the hash-diff heal. patchRemotePlayer never mints: a
    // hit for a departed/never-joined target drops instead of leaving a
    // phantom roster entry hashing client-only forever.
    if (Number.isFinite(data.health)) {
      this.h.patchRemotePlayer(data.targetId, { health: data.health, isDead: false });
    } else {
      this.h.patchRemotePlayer(data.targetId, { isDead: false });
    }
    this.h.onPlayerHit?.(data.shooterId, data.targetId, data.damage, data.health, data.armor);
  }

  private handlePlayerKill(data: Extract<ServerMessage, { type: 'playerKill' }>): void {
    // A kill IS the confirm — the fatal blow arrives as playerKill, not
    // playerHit, so the pending ledger would warn phantom otherwise.
    if (data.shooterId === this.h.getLocalPlayerId()) {this.h.confirmClaimHit(data.targetId);}
    // Update REMOTE player state (local player death handled by callback).
    // Same phantom-row guard as hits — a kill for a departed target must
    // not mint a stub corpse.
    this.h.patchRemotePlayer(data.targetId, { isDead: true, health: 0 });
    this.h.onPlayerKill?.(data.shooterId, data.targetId, data.weapon, data.air, data.steal);
  }

  /** Routed through the NetworkManager seam so tests can wrap/count it. */
  handleCorrection(data: Extract<ServerMessage, { type: 'correction' }>): void {
    // Server rejected our position — snap to last valid state
    const p = data.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      logger.warn(`Server correction at seq ${data.seq} with malformed position — dropped`);
      return;
    }
    logger.warn(`Server correction at seq ${data.seq}: pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`);
    this.h.ackPositionSeq(data.seq);
    this.h.onCorrection?.(data.seq, data.position, data.velocity, data.rotation, data.inputSeq, data.grounded);
  }
}
