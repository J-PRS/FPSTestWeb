// Inbound wire dispatch - the receive half of the wire seam.
//
// WireIn owns everything between "bytes/parsed frame arrive" and "world
// event fires": the handler table, the v3 wire-id roster + tick decode
// pool, and the per-room sequence watermarks (ev / tickSeq / hitSeq) that
// guard stale and re-delivered frames. What it does NOT own lives behind
// the host: NetworkManager keeps transport, the outbound claim/journal
// path, the remote-player roster store, and the onX event surface - the
// small host methods below are the whole back-channel.

import { ChildLogger } from '../core/Logger.js';
import { checkHit } from '../core/liveMonitor.js';
import {
  isWireFrame, decodeTickFrame, decodeBallAny, decodeProjSpawn, decodeProjGone,
  WIRE_BALLSEG, WIRE_BALLBATCH, WIRE_PROJSPAWN, WIRE_PROJGONE, WIRE_BATCH, WIRE_JSON, WIRE_HIT,
  WIRE_E_JUMP, WIRE_E_JET, WIRE_E_LANDED, WIRE_E_SHOT, WIRE_E_KNOCK, WIRE_KILL,
  decodeWireJson, decodeHit, decodeWidPos, decodeShotEv, decodeKnock, decodeKill, iterBatch, SERVER_TICK_MS,
  type TickDecodePool,
} from '../../../shared/wire.js';
import {type ServerMessage, type TickUpdatePlayer, PROTOCOL_VERSION} from '../../../shared/protocol.js';
import { WeaponType } from '../../../shared/weapons.js';
import { WORLD_MODEL, verbForType, checkPacket, rowPatch } from '../../../shared/worldModel.js';
import type { RemotePlayerState,NetworkManager } from './NetworkManager.js';
import { claim as netProbeClaim } from '../debug/netProbe.js';
import { parityProbes, hasPendingEcho, noteVictimDeath, noteVictimRespawn } from '../game/parity.js';
import { recWireIn, recHit } from '../core/telemetry.js';

import { rejectCensus, dedupCensus, dropCensus } from './claimLedger.js';

import { urlParams } from '../core/params.js';

const logger = new ChildLogger('Wire');

export class WireIn {
  /** v3 tick-frame roster: u16 -> playerId, fed by 'wireIds' events that
   *  always precede the first frame referencing them (same socket). */
  private readonly wireIds = new Map<number, string>();
  /** Decode slots reused every tick - upsert deep-fills roster vecs so
   *  rostered values never alias a slot (see decodeTickFrame pool docs). */
  private readonly tickPool: TickDecodePool = { slots: [], byId: new Map(), resolveId: (id): string | undefined => this.wireIds.get(id) };

  private lastTickSeq = -1; // highest server tickSeq applied - stale frames drop
  /** Seqs counted as missed that a late (reordered) arrival can cancel -
   *  unordered lanes reorder constantly; without this every reorder reads
   *  as packet loss in the HUD + telemetry. */
  private readonly pendingMissed = new Set<number>();
  /** Misses canceled by a late arrival - nonzero = the tick lane is
   *  unordered (datagrams), ~0 = stream-2's ordered pump is carrying it. */
  reorderCancels = 0;
  /** ?dropticks=N test hook - see the tick-path comment below. */
  private static dropEvery = Number(urlParams.get('dropticks') ?? 0) || 0;
  private static dropCounter = 0;
  /** Last processed reliable `ev` seq - the host presents it as
   *  resumeSeq on a token-carrying join so the server replays only the
   *  missed frames. */
  private lastEv = 0;
  /** Reconnect grace lets the server replay in-flight playerHit events -
   *  seq is per-room monotonic so a stale re-delivery can't double-apply.
   *  Reset on disconnect/gameState: a new room's seq restarts at 1, and a
   *  retained high watermark would silently drop every hit for the whole
   *  session - the "half my damage instances don't work" desync. */
  private lastHitSeq = 0;
  /** True once a gameState carried localPlayerState — the demote signal
   *  is a LATER gameState without it (genuine spectators never set it). */
  private hadSeat = false;

  /** Binary hits/kills that arrived before their wireIds minted - a
   *  journaled replay or a gameState race can deliver the damage edge
   *  ahead of the roster delta, and a hit dropped here is a MISSING
   *  DAMAGE INSTANCE. Park them until the next 'wireIds' mint resolves
   *  the ids; orphans past the staleness window drop with a warn. */
  private readonly pendingWidEvents: { at: number; hit?: { shooterWid: number; targetWid: number; damage: number; health: number; armor?: number; seq?: number; shotId?: string; gd?: number }; kill?: { shooterWid: number; targetWid: number; weapon?: number; streak?: number; air?: number; steal?: boolean }; proj?: ReturnType<typeof decodeProjSpawn> }[] = [];

  /** Ring of recent health-affecting events - read by the desync dump so a
   *  hash mismatch says WHICH event diverged, not just that one did. */
  private readonly recentHealthEvents: { type: string; t: number; detail: string }[] = [];
  private static readonly HEALTH_EVENT_TYPES = new Set(['playerHit', 'playerKill', 'playerRespawn', 'buff', 'heal']);

  constructor(private readonly h: NetworkManager) {}

  /** Reliable-side watermark for the join handshake's resumeSeq. */
  get evWatermark(): number { return this.lastEv; }

  /** Highest server tickSeq applied - e2e probes poll it as the
   *  "binary lane alive" signal. */
  get tickSeq(): number { return this.lastTickSeq; }
  /** Wire handlers that threw mid-message (contained, counted - see dispatch). */
  handlerThrows = 0;

  recentEvents(): readonly { type: string; t: number; detail: string }[] {
    return this.recentHealthEvents;
  }

  /** A disconnect starts fresh per-room seq spaces - a retained high
   *  watermark would silently drop every hit/tick of the next session. */
  resetForReconnect(): void {
    this.lastTickSeq = -1;
    this.lastHitSeq = 0;
    this.pendingMissed.clear();
    this.hadSeat = false; // new session, new seat — stale demote memory would double-join
  }

  /** Wire-feed seam - one message through the live dispatch path, so
   *  recorded streams (.rec replays) and sockets are indistinguishable. */
  dispatch(data: ServerMessage | Uint8Array): void {
    if (typeof data === 'object' && !(data instanceof Uint8Array)) {this.message(data);}
    else {this.binary(data as Uint8Array);}
  }

  /** Inbound that lands before the app binds its handler deps (the
   *  `h.*` hooks fill in during wireNetworkHandlers) queues here - the
   *  socket is opened at boot start to overlap the handshake with
   *  init, and a worldstate hitting unbound hooks would desync
   *  silently. Flushed through the normal dispatch on markReady. */
  private early: (ServerMessage | Uint8Array)[] = [];
  private ready = true; // boot arms the queue only for the early-connect window
  private earlyDrops = 0;

  /** Wall-clock stamps per lane - reliable JSON events and binary ticks
   *  ride separately drainable pipes (WT stream-0 vs datagram/stream-2).
   *  A seat can lose one without the other; the stall watchdog reads
   *  these to catch a seat that gets ticks but no events (dead JSON
   *  lane → hits/kills/spawns silently gone). */
  lastJsonRxAt = 0;
  lastBinRxAt = 0;
  /** Any inbound EXCEPT inputSync - which is the server's starvation
   *  signal, not proof of life: a zombie seat that only gets inputSync
   *  trickles is dead (soak: 75s of inputSync with zero ticks/events -
   *  it kept resetting the liveness clock so the plain watchdog never
   *  fired). */
  lastLiveRxAt = 0;

  armEarlyQueue(): void { this.ready = false; }

  markReady(): void {
    this.ready = true;
    const q = this.early;
    this.early = [];
    if (this.earlyDrops > 0) {logger.warn(`wireIn dropped ${this.earlyDrops} early binary messages over the 512 cap`);}
    for (const m of q) {this.dispatch(m);}
  }

  private gate(data: ServerMessage | Uint8Array): boolean {
    if (this.ready) {return false;}
    // Per-lane QoS, the GONet/yojimbo split: binary frames are
    // latest-wins motion/tick traffic (high-frequency, safe to drop);
    // JSON messages are must-deliver edges (roster, gameState, joins -
    // bounded by entity count, not time). Capping JSON dropped the join
    // roster → frozen bots for ~53s until resync; binary under cap is
    // stale on arrival anyway.
    if (!(data instanceof Uint8Array)) {this.early.push(data);}
    else if (this.early.length < 512) {this.early.push(data);}
    else {
      // At cap the OLDEST binary is the stalest - evict it, not the new
      // delta (old behavior buffered 512 stale ticks and dropped fresh
      // state, so post-flush entities replayed a dead epoch). JSON edges
      // never evict - they're must-deliver by design.
      const idx = this.early.findIndex((m) => m instanceof Uint8Array);
      if (idx !== -1) {this.early.splice(idx, 1); this.early.push(data);}
      this.earlyDrops += 1;
    }
    return true;
  }

  message(data: ServerMessage, bytes?: number): void {
    if (this.gate(data)) {return;}
    // inputSync doesn't count as lane health - the server sends it when
    // OUR uplink looks starved, so it's literally the symptom marker of
    // the split-lane failure (a dead reliable lane saw only inputSync for
    // 75s in soak). Everything else - pings, hashes, events - stamps.
    if (data.type !== 'inputSync') {this.lastJsonRxAt = Date.now(); this.lastLiveRxAt = Date.now(); this.h.resetJsonLaneCounter();}
    parityProbes.msgSeen[data.type] = (parityProbes.msgSeen[data.type] ?? 0) + 1;
    recWireIn(data.type, bytes);
    // Rx is an approximation anyway - re-stringifying every event just to
    // size it cost a full second pass over reclaim replays (a 1024-frame
    // burst arrived as one giant main-thread task).
    this.h.noteRx(bytes ?? 256);
    this.noteWireMeta(data);
    // Avoid JSON.stringify on every message - tickUpdate arrives at 20Hz
    const handler = this.handlers[data.type] as ((d: ServerMessage) => void) | undefined;
    if (handler) {
      // A malformed-but-parseable message mustn't reach the connection's
      // onError path - one bad packet shouldn't cost a reconnect.
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

  /** Per-message bookkeeping that isn't dispatch: ev watermark, session
   *  token capture, health-event ring, declared-verb field check. */
  private noteWireMeta(data: ServerMessage): void {
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
    // Declared entity verbs get the inbound field check - a packet that
    // drops a declared field warns here instead of desyncing silently.
    const decl = verbForType(data.type);
    if (decl) {checkPacket(decl.kind, decl.verb, data as unknown as Record<string, unknown>);}
  }

  /** Byte -> frame handler. Known event bytes dispatch here; anything
   *  else falls through to the tick path (tick frames have no event
   *  byte - the tickSeq watermark + decodeTickFrame own them). Order
   *  is irrelevant: every WIRE_* constant is unique. */
  private readonly binDispatch = new Map<number, (data: Uint8Array) => void>([
    [WIRE_BATCH, (d): void => { for (const sub of iterBatch(d)) {this.binary(sub);} }],
    [WIRE_JSON, (d): void => this.onWireJson(d)],
    [WIRE_HIT, (d): void => this.onWireHit(d)],
    [WIRE_E_JUMP, (d): void => this.onWidPos(d)],
    [WIRE_E_JET, (d): void => this.onWidPos(d)],
    [WIRE_E_LANDED, (d): void => this.onWidPos(d)],
    [WIRE_E_SHOT, (d): void => this.onWireShot(d)],
    [WIRE_E_KNOCK, (d): void => this.onWireKnock(d)],
    [WIRE_KILL, (d): void => this.onWireKill(d)],
    [WIRE_PROJSPAWN, (d): void => this.onProjSpawn(d)],
    [WIRE_PROJGONE, (d): void => this.onProjGone(d)],
    [WIRE_BALLSEG, (d): void => this.onBallWire(d)],
    [WIRE_BALLBATCH, (d): void => this.onBallWire(d)],
  ]);

  binary(data: Uint8Array): void {
    if (this.gate(data)) {return;}
    this.lastBinRxAt = Date.now();
    this.lastLiveRxAt = Date.now();
    this.h.noteRx(data.length);
    if (!isWireFrame(data)) {
      logger.debug(`Received non-wire binary message: ${data.length} bytes`);
      return;
    }
    recWireIn(`bin:${data[1] ?? -1}`, data.length);
    const handler = this.binDispatch.get(data[1] ?? -1);
    if (handler) {handler(data); return;}
    this.tickFrame(data);
  }

  // Reliable events batched into the binary lane arrive JSON-in-binary -
  // decode to text and run the ordinary message dispatch (same parse,
  // same watermarks - ev sequencing is preserved by subframe order).
  private onWireJson(data: Uint8Array): void {
    const text = decodeWireJson(data);
    if (text === null) {return;}
    try { this.message(JSON.parse(text)); }
    catch (error) {this.handlerThrows += 1; logger.warn(`wire-json subframe failed: ${error instanceof Error ? error.message : String(error)}`);}
  }

  /** shooterWid 0 is the environment sentinel - everything else resolves
   *  through the wireId roster (undefined until the roster lands). */
  private resolveShooterId(wid: number): string | undefined {
    return wid === 0 ? 'environment' : this.wireIds.get(wid);
  }

  // playerHit on the binary lane - resolve wireIds then run the same
  // message() dispatch the JSON event used (seq dedupe preserved).
  private onWireHit(data: Uint8Array): void {
    const h = decodeHit(data);
    if (!h) {return;}
    const targetId = this.wireIds.get(h.targetWid);
    const shooterId = this.resolveShooterId(h.shooterWid);
    if (!targetId || !shooterId) {this.pendingWidEvents.push({ at: Date.now(), hit: h }); this.drainPendingWidEvents(); return;}
    try { this.message({ type: 'playerHit', shooterId, targetId, damage: h.damage, health: h.health, armor: h.armor, seq: h.seq, shotId: h.shotId, gd: h.gd }); }
    catch (error) {this.handlerThrows += 1; logger.warn(`wire-hit subframe failed: ${error instanceof Error ? error.message : String(error)}`);}
  }

  // Presence relays - wireId + pos, run the JSON-path dispatch so the
  // handlers see the identical message shape either lane.
  private onWidPos(data: Uint8Array): void {
    const w = decodeWidPos(data, data[1]!);
    const playerId = w ? this.wireIds.get(w.wid) : undefined;
    if (w && playerId) {
      try {
        if (data[1] === WIRE_E_LANDED) {this.message({ type: 'landed', playerId, pos: w.pos, impact: w.extra } as ServerMessage);}
        else {this.message({ type: data[1] === WIRE_E_JUMP ? 'jump' : 'jetpack', playerId, position: w.pos });}
      }
      catch (error) {this.handlerThrows += 1; logger.warn(`wire-presence failed: ${error instanceof Error ? error.message : String(error)}`);}
    }
  }

  private onWireShot(data: Uint8Array): void {
    const s = decodeShotEv(data);
    const id = s ? this.wireIds.get(s.wid) : undefined;
    if (s && id) {
      try { this.message({ type: 'playerShot', id, weaponType: s.weaponType, pos: s.pos, dir: s.dir }); }
      catch (error) {this.handlerThrows += 1; logger.warn(`wire-shotev failed: ${error instanceof Error ? error.message : String(error)}`);}
    }
  }

  private onWireKnock(data: Uint8Array): void {
    const k = decodeKnock(data);
    const targetId = k ? this.wireIds.get(k.wid) : undefined;
    if (k && targetId) {
      try { this.message({ type: 'knockback', targetId, position: k.pos, force: k.force, pull: k.pull, yank: k.yank }); }
      catch (error) {this.handlerThrows += 1; logger.warn(`wire-knock failed: ${error instanceof Error ? error.message : String(error)}`);}
    }
  }

  private onWireKill(data: Uint8Array): void {
    const k = decodeKill(data);
    const targetId = k ? this.wireIds.get(k.targetWid) : undefined;
    const shooterId = k ? this.resolveShooterId(k.shooterWid) : undefined;
    if (k && (!targetId || !shooterId)) {this.pendingWidEvents.push({ at: Date.now(), kill: k }); this.drainPendingWidEvents(); return;}
    if (k && targetId && shooterId) {
      try { this.message({ type: 'playerKill', shooterId, targetId, weapon: k.weapon, streak: k.streak, air: k.air, steal: k.steal }); }
      catch (error) {this.handlerThrows += 1; logger.warn(`wire-kill failed: ${error instanceof Error ? error.message : String(error)}`);}
    }
  }

  private onProjSpawn(data: Uint8Array): void {
    const s = decodeProjSpawn(data);
    const ownerId = s ? this.wireIds.get(s.ownerWireId) : undefined;
    if (s && !ownerId) {this.pendingWidEvents.push({ at: Date.now(), proj: s }); this.drainPendingWidEvents(); return;}
    if (s && ownerId) {
      try { this.h.onProjectileCreated?.(`sp-${s.projId}`, ownerId, s.position, s.velocity, s.weaponType, s.shotId, s.pellet, s.age || undefined, s.t); }
      catch (error) {this.handlerThrows += 1; logger.warn(`Handler threw for projSpawn: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);}
    }
  }

  private onProjGone(data: Uint8Array): void {
    const g = decodeProjGone(data);
    if (g) {
      try { this.h.onProjectileDestroyed?.(`sp-${g.projId}`, g.shotId, g.position, g.age); }
      catch (error) {this.handlerThrows += 1; logger.warn(`Handler threw for projGone: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);}
    }
  }

  // Binary ball segments decode straight into the JSON message's shape -
  // netBallSegment sees one type regardless of transport.
  private onBallWire(data: Uint8Array): void {
    const segs = decodeBallAny(data);
    for (const seg of segs) {
      // The frame decodes to flat scalars - the declared updateFields
      // own which ones cross into the JSON shape handlers see.
      const src = seg as unknown as Record<string, unknown>;
      const msg: Record<string, unknown> = { type: 'ballSegment', id: seg.id };
      for (const f of WORLD_MODEL.ball!.updateFields!) {msg[f.name] = src[f.name];}
      try { this.h.onBallSegment?.(msg as unknown as Extract<ServerMessage, { type: 'ballSegment' }>); }
      catch (error) {this.handlerThrows += 1; logger.warn(`Handler threw for ballSegment: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`); }
    }
  }

  /** Tick frames carry no event byte - every unrecognized frame lands
   *  here: stale-drop, loss-gap accounting, decode, dispatch. */
  /** Stale-drop BEFORE decode: v4 decode mutates the byId baseline - an
   *  out-of-order datagram frame would smuggle its stale fields into the
   *  retained slots even when dropped here. tickSeq sits at bytes 6-9. */
  private isStaleTick(data: Uint8Array): boolean {
    if (data.byteLength < 15) {return false;}
    const seq = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(6, true);
    if (seq > this.lastTickSeq) {return false;}
    // A "lost" seq arriving late is a reorder, not loss - cancel the
    // miss we counted (unordered lanes reorder constantly; 88% fake
    // loss on a perfect wire in the seqwatch soak).
    if (this.pendingMissed.delete(seq)) {this.reorderCancels += 1; this.h.onSeqReorder?.(1);}
    return true;
  }

  private tickFrame(data: Uint8Array): void {
    if (this.isStaleTick(data)) {return;}
    // ?dropticks=N - drop every Nth tick frame before decode to exercise
    // the tickNack recovery loop (localhost can't produce real loss).
    if (WireIn.dropEvery > 0 && (WireIn.dropCounter += 1) >= WireIn.dropEvery) { WireIn.dropCounter = 0; return; }
    const tick = decodeTickFrame(data, this.tickPool);
    if (!tick) {return;}
    // A real loss (the <= drop above already ate reorders): masked fields
    // in the gap are stale until each wireId's staggered full lands -
    // ask for a full-record window instead of waiting out the ~750ms.
    // Only count a gap on an ESTABLISHED stream (lastTickSeq >= 0): the
    // first frame after join/reset starts mid-room-seq, which is not a
    // loss - it used to count thousands of phantom misses into seqWindow
    // (100% packetLoss for the session's first 5s) and nack a burst the
    // roster-intro fulls already cover.
    if (this.lastTickSeq >= 0 && tick.tickSeq - this.lastTickSeq > 1) {
      const gap = tick.tickSeq - this.lastTickSeq - 1;
      this.h.onTickGap?.(gap);
      // Remember the seqs counted as missed - a late arrival (unordered
      // datagram lane) cancels its own miss instead of reporting loss.
      for (let s = this.lastTickSeq + 1; s < tick.tickSeq; s += 1) {this.pendingMissed.add(s);}
      if (this.pendingMissed.size > 256) {this.pendingMissed.clear();}
    }
    this.lastTickSeq = tick.tickSeq;
    // Same containment as the JSON path - a throwing tick handler at 20Hz
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
        // owner's decode baseline - deltas can't decode against it.
        if (this.wireIds.has(id)) {this.tickPool.byId?.delete(id);}
        this.wireIds.set(id, pid);
      }
      for (const id of data.remove ?? []) {
        this.wireIds.delete(id);
        // A reissued id must seat a fresh baseline - never inherit the
        // departed owner's retained fields (see WireIdRoster.feed).
        this.tickPool.byId?.delete(id);
      }
      this.drainPendingWidEvents();
    },
    teamUpdate: (data): void => { this.h.patchRemotePlayer(data.playerId, { team: data.team }); },
    playerHeld: (data): void => { this.h.patchRemotePlayer(data.playerId, { held: data.n }); this.h.onPlayerHeld?.(data.playerId, data.n); },
    playerRespawn: (data): void => this.handlePlayerRespawn(data),
    playerHit: (data): void => this.handlePlayerHit(data),
    buff: (data): void | undefined => this.h.onBuff?.(data),
    yourHealth: (data): void => {
      this.h.lastHealthEventAt = Date.now();
      this.h.onYourHealth?.(data.health, data.armor);
    },
    yourCharge: (data): void | undefined => this.h.onYourCharge?.(data.charge),
    yourAmmo: (data): void | undefined => this.h.onYourAmmo?.(data.ammo),
    // Gun-game ladder edge (owner-only): swap the locked band to the
    // rung weapon. Prediction only - the server gate is the law.
    gunRung: (data): void | undefined => this.h.onGunRung?.(data.rung, data.wt),
    playerKill: (data): void => this.handlePlayerKill(data),
    knockback: (data): void | undefined => this.h.onKnockback?.(data.position, data.force, data.pull, data.yank),
    jump: (data): void | undefined => this.h.onPlayerJump?.(data.playerId, data.position),
    jetpack: (data): void | undefined => this.h.onPlayerJetpack?.(data.playerId, data.position),
    projectileCreated: (data): void | undefined => this.h.onProjectileCreated?.(data.projectileId, data.ownerId, data.position, data.velocity, data.weaponType, data.shotId, data.pellet, data.age, data.t),
    playerShot: (data): void | undefined => this.h.onPlayerShot?.(data.id, data.weaponType, data.pos, data.dir),
    projectileDestroyed: (data): void | undefined => this.h.onProjectileDestroyed?.(data.projectileId, data.shotId, data.position ?? undefined, data.age ?? undefined),
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
    // Server-issued RTT probe - echo it back untouched so the server
    // measures round-trip itself instead of trusting our reported ping.
    ping: (data): void => this.h.pingReceived(data.timestamp),
    pong: (data): void => this.h.pongReceived(data.timestamp),
    srvPing: (data): void => { this.h.noteSrvPing?.(typeof data.rtt === 'number' ? data.rtt : null); },
    chat: (data): void | undefined => this.h.onChat?.(data.playerId, data.text, data.team === true, typeof data.vgs === 'string' ? data.vgs : undefined, data.muted === true),
    flagUpdate: (data): void | undefined => this.h.onFlagUpdate?.(data.flags),
    nodeUpdate: (data): void | undefined => this.h.onNodeUpdate?.(data.nodes),
    matchNotice: (data): void | undefined => this.h.onMatchNotice?.(data.text, data),
    serverWarn: (data): void | undefined => this.h.onServerWarn?.(data.text),
    // WT/RTC path of the 1008 identity reject - the close code is lost
    // on those tiers, so the server sends this before closing.
    sessionRejected: (data): void => this.h.rejectSession(data.reason),
    pickupSpawn: (data): void | undefined => this.h.onPickupSpawn?.(data.id, data.pos, data.kind, data.val, data.vel),
    pickupGone: (data): void | undefined => this.h.onPickupGone?.(data.id, data.by ?? null),
    teamScore: (data): void | undefined => this.h.onTeamScore?.(data.scores, data.winAt),
    ffaScore: (data): void | undefined => this.h.onFfaScore?.(data.scores, data.winAt, data.playerId, data.score, data.rm),
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
    intel: (data): void | undefined => this.h.onIntel?.(data.seen, data.mem),
    turretShot: (data): void | undefined => this.h.onTurretShot?.(data.id, data.owner, data.targetId),
    sentryShot: (data): void | undefined => this.h.onSentryShot?.(data.id, data.owner, data.x, data.y, data.z),
    mortarShot: (data): void | undefined => this.h.onMortarShot?.(data.id, data.owner, data.vx, data.vy, data.vz),
    mineBoom: (data): void | undefined => this.h.onMineBoom?.(data.id, data.pos),
    padBoing: (data): void | undefined => this.h.onPadBoing?.(data.id, data.pos, { x: data.nx, y: data.ny, z: data.nz }),
    loiterDive: (data): void | undefined => this.h.onLoiterDive?.(data.id, data.pos, { x: data.vx, y: data.vy, z: data.vz }),
    landed: (data): void | undefined => this.h.onLanded?.(data.playerId, data.pos, data.impact),
    deployHp: (data): void | undefined => this.h.onDeployHp?.(data.id, data.hp, data.armor, data.src),
    // Server refused a hit claim - worth surfacing: a healthy client
    // should basically never see this, so it's a desync tell.
    shotRejected: (data): void => {
rejectCensus.total += 1;
      rejectCensus.byReason.set(data.reason, (rejectCensus.byReason.get(data.reason) ?? 0) + 1);
      rejectCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) {this.h.confirmClaimHit(data.targetId ?? '', data.shotId);}
      const wName = data.weaponType === undefined ? undefined : String(WeaponType[data.weaponType] ?? data.weaponType);
      netProbeClaim('reject', data.reason, wName, data.targetId, this.h.getPing());
      logger.error(`shot rejected - predicted damage never applied: ${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`, {
        reason: data.reason,
        targetId: data.targetId,
        weapon: wName,
        pingMs: this.h.getPing(),
      });
      this.h.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health, data.shotId);
    },
    // Honest-lag discard (dead shooter/target) - not a reject, but the
    // predicted hit still needs clearing or the ledger warns phantom.
    claimDropped: (data): void => {
dropCensus.total += 1;
      dropCensus.byReason.set(data.reason, (dropCensus.byReason.get(data.reason) ?? 0) + 1);
      dropCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) {this.h.confirmClaimHit(data.targetId ?? '', data.shotId);}
      netProbeClaim('drop', data.reason, data.weaponType === undefined ? undefined : String(WeaponType[data.weaponType] ?? data.weaponType), data.targetId, this.h.getPing());
      logger.warn(`claim dropped - predicted damage never applied: ${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`, {
        reason: data.reason, targetId: data.targetId,
        weapon: data.weaponType === undefined ? undefined : WeaponType[data.weaponType] ?? data.weaponType,
        pingMs: this.h.getPing(),
      });
      this.h.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health, data.shotId);
    },
  };

  private handleGameState(data: Extract<ServerMessage, { type: 'gameState' }>): void {
    performance.mark('load:gameStateArrived');
    // A new gameState means a new room instance - both seq spaces
    // restart at 1 (hitSeq and tickSeq are per-room), so the prior
    // room's high watermarks must not gate it. A room hop without
    // reconnect would otherwise freeze every remote for the session.
    this.lastHitSeq = 0;
    this.lastTickSeq = -1;
    this.pendingMissed.clear();
    this.h.dropClaims(false);
    this.h.clearResyncQuiet(); // truth landed - position claims are judged fresh
    const serverProto = data.protocolVersion ?? 0;
    if (!this.checkProtocol(serverProto)) {return;}
    try { sessionStorage.removeItem('fps-proto-reload'); } catch { /* no budget to reset */ } // clean connect - reset the budget
    // pv did its one job (bust the CDN's stale bundle on the mismatch
    // reload) — drop it from the bar so /s/ links stay clean.
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('pv')) {
      const u = new URL(window.location.href);
      u.searchParams.delete('pv');
      history.replaceState(null, '', u.toString());
    }

    // gameState is the authoritative roster on (re)connect - clear stale
    // entries for players who left during our disconnect, then add the
    // current set. v3 ids are per-room: the snapshot replaces, not merges.
    this.wireIds.clear();
    // Same epoch rule for queued binary hits - their wids belong to the
    // room that sent them; resolving against a new room's map would
    // misattribute the damage.
    this.pendingWidEvents.length = 0;
    // v4 masked deltas inherit per-wireId state - a new room epoch must
    // not let a reassigned id keep the old player's last-decoded fields.
    this.tickPool.byId?.clear();
    if (data.wireIds) {for (const [id, pid] of Object.entries(data.wireIds)) {this.wireIds.set(Number(id), pid);}}
    // wid-orphan forensics: an empty/absent seed followed by unminted
    // binary events means this gameState wiped the roster blind.
    logger.warn(`gameState wids=${data.wireIds === undefined ? 'ABSENT' : Object.keys(data.wireIds).length} room=${String(data.room)}`);
    this.drainPendingWidEvents();
    this.h.remoteReset(data.players);
    // Seat is (re)established - replay fire intents a dead lane may have
    // lost. Server dedupes by shotId, so a shot that DID land is a no-op.
    this.h.replayFireIntents(data.room, data.udp);
    // AFK demotion detection: a seat we used to hold answers resync with
    // the bare spectator envelope (no localPlayerState) — combat claims
    // get refused from here on, so the only sane move is to re-join.
    // Gated on having held a seat before: a genuine spectator handshake
    // must not rejoin-loop.
    if (data.localPlayerState) {this.hadSeat = true;}
    else if (this.hadSeat) {
      this.hadSeat = false;
      logger.warn(`gameState has no localPlayerState — seat was demoted, re-joining room=${String(data.room)}`);
      this.h.reseat();
    }
    logger.debug(`raw gameState map: ${data.map ? JSON.stringify(data.map).slice(0, 300) : 'none'}`);
    this.h.onGameState?.(data.players || [], data.localPlayerState, { room: data.room, mode: data.mode, instagib: data.instagib, gungame: data.gungame, igun: data.igun, mapName: data.mapName, team: data.team, scores: data.scores, ffaScores: data.ffaScores, pickups: data.pickups, flags: data.flags, matchEndsAt: data.matchEndsAt, respawnMs: data.respawnMs, deployables: data.deployables, map: data.map });
  }

  /** Protocol handshake: a stale bundle can't parse a new wire format -
   *  force-reload once (cache-busted) instead of silently desyncing. The
   *  sessionStorage counter caps it at 2 attempts so a genuinely newer
   *  server can't reload-loop the tab. Returns false when the caller must
   *  bail (mismatch handled here). */
  private checkProtocol(serverProto: number): boolean {
    if (serverProto === PROTOCOL_VERSION) {return true;}
    // Storage can throw (private mode / disabled embeds) - treat a dead
    // counter as budget spent: warn + bail, never crash the handler.
    let tries = 2;
    try { tries = Number(sessionStorage.getItem('fps-proto-reload') ?? '0'); } catch { /* fall through */ }
    logger.warn(`Protocol mismatch: client=${PROTOCOL_VERSION} server=${serverProto} (attempt ${tries + 1})`);
    // Browser-only escape: headless harnesses (vitest, e2e replays) have
    // no location to reload - they get the warn + early return only.
    if (tries < 2 && typeof window !== 'undefined') {
      try {
        sessionStorage.setItem('fps-proto-reload', String(tries + 1));
        const url = new URL(window.location.href);
        url.searchParams.set('pv', String(Date.now())); // cache-buster vs CDN staleness
        window.location.href = url.toString();
      } catch { /* storage/nav both optional - warn already logged */ }
    } else if (typeof window !== 'undefined') {
      // Budget spent - a live socket with remotes frozen forever reads as
      // "game is broken", not "stale build". Close it so the normal
      // disconnect UI can name the failure. (Harnesses without a location
      // keep the warn + return.)
      this.h.disconnect();
    }
    return false;
  }

  private handleTickUpdate(data: { updates: TickUpdatePlayer[]; count?: number; ackSeq?: number; inputAck?: number; tickSeq?: number }): void {
    this.h.tickArrived();
    // Batched player updates from server (delta compressed)
    if (data.ackSeq !== undefined && data.ackSeq > 0) {
      this.h.ackPositionSeq(data.ackSeq);
    }
    // Tick-set confirm: the server consumed inputs ≤ inputAck - those
    // journal entries are dead weight and only matter to replay.
    if (data.inputAck !== undefined && data.inputAck > 0) {
      this.h.ackInputs(data.inputAck);
    }
    if (!data.updates || !Array.isArray(data.updates)) {return;}
    const now = Date.now();
    // Snapshots must carry the SERVER timeline (tickSeq×50), not arrival
    // wall time - arrival stamps fold transport jitter into the rendered
    // path itself, which is the rubberband mechanism. The JSON path has
    // no tickSeq and keeps the arrival fallback (host/loopback: jitter≈0).
    const serverMs = data.tickSeq === undefined ? now : data.tickSeq * SERVER_TICK_MS;
    // Pooled decode hands back its whole slots array + a live count -
    // entries past it are stale from earlier, larger frames.
    const n = Math.min(data.count ?? data.updates.length, data.updates.length);
    for (let i = 0; i < n; i += 1) {
      const u = data.updates[i]!; // n is clamped to updates.length above
      // v3 record ahead of its roster - can't build a body without an
      // identity, so it drops; the next record for that id resolves.
      if (!u.playerId) {continue;}
      this.applyTickPlayerUpdate(u, serverMs);
    }
  }

  // Scratch patch reused per record - one fresh object per remote per
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
    // Rejoins (grace-period reconnects) re-broadcast playerJoined - only the
    // FIRST sighting is a roster event. Upserting health/isDead on a rejoin
    // would stomp the server-truth values tickUpdate already delivered, and
    // re-firing onPlayerJoined spam-recreates/logs the remote every time.
    const isNew = !this.h.remoteHas(data.playerId);
    const patch = rowPatch(WORLD_MODEL.player.spawnFields!, data as unknown as Record<string, unknown>) as Partial<RemotePlayerState>;
    // Rejoins get identity fields but not vitals - a grace rejoiner
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
    // >1.5m off the victim's live truth - the "hit where nobody stood"
    // feel, named on the shooter's HUD via the complaint feed.
    if (data.gd != null && data.shooterId === this.h.getLocalPlayerId()) {
      logger.warn(`ghost hit on ${data.targetId} - credited ${data.gd}m behind the live body`, { gd: data.gd });
    }
    // Telemetry audit: did a prediction stamp precede this wire hit?
    // The confirm below consumes it, so the pending state must be read
    // first - a 'predicted:false' row names the reverse class (server
    // damage the client never predicted).
    const wasPredicted = hasPendingEcho(data.targetId);
    if (data.shooterId === this.h.getLocalPlayerId()) {this.h.confirmClaimHit(data.targetId, data.shotId);}
    if (data.seq !== undefined) {
      if (data.seq <= this.lastHitSeq) {
dedupCensus.hitSeqDrops += 1;
        logger.warn(`playerHit dropped as stale seq ${data.seq} <= ${this.lastHitSeq}`);
        return;
      }
      this.lastHitSeq = data.seq;
    }
    checkHit(data.shotId, data.targetId, data.seq, data.damage);
    recHit(data.shooterId, data.targetId, data.damage, wasPredicted);
    if (data.targetId === this.h.getLocalPlayerId()) {this.h.lastHealthEventAt = Date.now();}
    // Update REMOTE player health in storage (local player health handled
    // by callback). A processed hit also proves the server holds the target
    // alive - it never lands a hit on a dead player - so a record still
    // marked dead from a lost respawn edge un-sticks here instead of
    // waiting for the hash-diff heal. patchRemotePlayer never mints: a
    // hit for a departed/never-joined target drops instead of leaving a
    // phantom roster entry hashing client-only forever.
    if (Number.isFinite(data.health)) {
      this.h.patchRemotePlayer(data.targetId, { health: data.health, isDead: false });
    } else {
      this.h.patchRemotePlayer(data.targetId, { isDead: false });
    }
    noteVictimRespawn(data.targetId);
    this.h.onPlayerHit?.(data.shooterId, data.targetId, data.damage, data.health, data.armor, wasPredicted);
  }

  private handlePlayerKill(data: Extract<ServerMessage, { type: 'playerKill' }>): void {
    // A kill IS the confirm - the fatal blow arrives as playerKill, not
    // playerHit, so the pending ledger would warn phantom otherwise.
    const killWasPredicted = hasPendingEcho(data.targetId);
    // playerKill carries no shotId - the victim-only fallback consume
    // handles it; shot-aware consume rides the playerHit path.
    if (data.shooterId === this.h.getLocalPlayerId()) {this.h.confirmClaimHit(data.targetId);}
    recHit(data.shooterId, data.targetId, -1, killWasPredicted);
    // Update REMOTE player state (local player death handled by callback).
    // Same phantom-row guard as hits - a kill for a departed target must
    // not mint a stub corpse.
    this.h.patchRemotePlayer(data.targetId, { isDead: true, health: 0 });
    noteVictimDeath(data.targetId);
    this.h.onPlayerKill?.(data.shooterId, data.targetId, data.weapon, data.air, data.steal);
  }

  /** Retry wid-unresolved binary hits/kills - resolves once the roster
   *  learns the ids (wireIds delta, gameState seed) or drops with a warn
   *  past the staleness window. A queued hit that replays carries its
   *  original seq, so handlePlayerHit's dedup still applies. */
  private drainPendingWidEvents(): void {
    if (this.pendingWidEvents.length === 0) {return;}
    const now = Date.now();
    for (let i = this.pendingWidEvents.length - 1; i >= 0; i -= 1) {
      const p = this.pendingWidEvents[i]!;
      // Mints ride the same reliable broadcast - an unminted-wid event
      // resolves within a packet or two. 1500ms is far above the lane-
      // reorder window and far BELOW the wireId reissue quiet window, so
      // a stale frame can't resolve against a recycled id's new owner.
      if (now - p.at > 1500) {
        this.pendingWidEvents.splice(i, 1);
        let kind = 'projSpawn';
        if (p.hit) {kind = 'hit';} else if (p.kill) {kind = 'kill';}
        logger.warn(`binary ${kind} orphaned - wid never minted for ${JSON.stringify(p.hit ?? p.kill ?? p.proj)}`);
        continue;
      }
      const run = this.widReplay(p);
      if (!run) {continue;}
      this.pendingWidEvents.splice(i, 1);
      run();
    }
  }

  /** Resolve one queued wid event against the roster; returns the dispatch
   *  closure (caller splices BEFORE running it - replay-once even if the
   *  handler throws) or null while its wids are still unminted. */
  private widReplay(p: (typeof this.pendingWidEvents)[number]): (() => void) | null {
    if (p.hit) {
      const targetId = this.wireIds.get(p.hit.targetWid);
      const shooterId = p.hit.shooterWid === 0 ? 'environment' : this.wireIds.get(p.hit.shooterWid);
      if (!targetId || !shooterId) {return null;}
      const h = p.hit;
      return (): void => { this.message({ type: 'playerHit', shooterId, targetId, damage: h.damage, health: h.health, armor: h.armor, seq: h.seq, shotId: h.shotId, gd: h.gd }); };
    }
    const k = p.kill;
    if (k) {
      const targetId = this.wireIds.get(k.targetWid);
      const shooterId = k.shooterWid === 0 ? 'environment' : this.wireIds.get(k.shooterWid);
      if (!targetId || !shooterId) {return null;}
      return (): void => { this.message({ type: 'playerKill', shooterId, targetId, weapon: k.weapon, streak: k.streak, air: k.air, steal: k.steal }); };
    }
    const s = p.proj!;
    const ownerId = this.wireIds.get(s.ownerWireId);
    if (!ownerId) {return null;}
    return (): void => { this.h.onProjectileCreated?.(`sp-${s.projId}`, ownerId, s.position, s.velocity, s.weaponType, s.shotId, s.pellet, s.age || undefined, s.t); };
  }

  /** Routed through the NetworkManager seam so tests can wrap/count it. */
  handleCorrection(data: Extract<ServerMessage, { type: 'correction' }>): void {
    // Server rejected our position - snap to last valid state
    const p = data.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      logger.warn(`Server correction at seq ${data.seq} with malformed position - dropped`);
      return;
    }
    logger.warn(`Server correction at seq ${data.seq}: pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`);
    this.h.ackPositionSeq(data.seq);
    this.h.onCorrection?.(data.seq, data.position, data.velocity, data.rotation, data.inputSeq, data.grounded);
  }
}
