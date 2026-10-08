/**
 * P2P host authority — the real server modules running in the host's
 * browser. PlayerManager + CombatHandler + validation are reused verbatim
 * from server_bun/ (they're pure TS), so hit-claim validation, damage
 * clamps, respawn timers, and the wire codec are IDENTICAL to dedicated-
 * server rules — only the transport differs: links are a loopback (the
 * host's own client) or a WebRTC DataChannel (the guest).
 *
 * Deliberately absent vs GameServer: grace-period reconnects (a dropped
 * DataChannel rejoins fresh), ball sim (guests run client-side balls),
 * state-hash + idle reaper (two sockets, nothing to reap at scale).
 *
 * The weapon sims are NOT absent: RoomProjectiles + beamSweepRay run on
 * the host's heightfield, so peers send the same fire/beam intents a
 * dedicated server takes — outcome claims stay for the surfaces that
 * have no sim here (creatures, deployables, repair).
 */

import { PlayerManager } from '../../../../server_bun/src/PlayerManager.js';
import { MessageHandler, type RoomInfo } from '../../../../server_bun/src/MessageHandler.js';
import { RateLimiter } from '../../../../server_bun/src/RateLimiter.js';
import { validateMessage } from '../../../../server_bun/src/wire.js';
import { validatePlayerId } from '../../../../server_bun/src/validation.js';
import { isWireFrame, decodePosition, encodeTickPlayer, encodeTickFrame } from '../../../../shared/wire.js';
import type { ServerMessage } from '../../../../shared/protocol.js';
import { ChildLogger } from '../../core/Logger.js';
import { RoomProjectiles } from '../../../../server_bun/src/RoomProjectiles.js';
import { RoomMoveSim } from '../../../../server_bun/src/RoomMoveSim.js';
import { ENERGY } from '../../../../shared/movement.js';
import { beamSweepRay } from '../../../../server_bun/src/beamSweep.js';
import { getHeightfield } from '../../world/heightmap.js';

const logger = new ChildLogger('P2PHost');

/** One peer's pipe into the authority — loopback or DataChannel-backed.
 *  send() takes the same frames a socket would: JSON text or binary wire. */
export interface P2PLink {
  send(data: string | Uint8Array): void;
  close(): void;
}

export class P2PHost {
  private playerManager = new PlayerManager();
  private rateLimiter = new RateLimiter();
  private messageHandler: MessageHandler;
  private links = new Map<P2PLink, string>(); // link → playerId
  private byPlayer = new Map<string, P2PLink>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickClock: Worker | null = null;
  tickSeq = 0;
  /** ProjHost surface — the weapon sims run on this host exactly as they
   *  do on a Room; `this` IS the room to RoomProjectiles. */
  readonly mode = 'p2p';
  private fieldAttached = false;

  get players() { return this.playerManager; }
  get messages() { return this.messageHandler; }
  rng(): number { return Math.random(); }
  /** No bots on P2P — blasts have nobody to wake. */
  pushNoise(): void { /* intentionally silent */ }

  private readonly projectiles: RoomProjectiles;
  /** Peer moveReports reconcile against a shadow sim — the host judges
   *  teleports instead of relaying them verbatim. */
  private readonly moveShadows = new RoomMoveSim(null, true);
  private readonly roomInfo: RoomInfo = {
    room: 'p2p',
    mode: 'p2p',
    // Peers send the same fire/beam intents a dedicated server takes.
    // claimsAccepted stays true — the roster surfaces this host can't
    // sim (creatures, deployables, repair) still adjudicate claims.
    fireProjectile: (pid, wt, origin, dir, vel, shotId) =>
      this.projectiles.spawn(pid, wt, origin, dir, vel, shotId),
    beamSweep: (pid, muzzle, dir, range) =>
      beamSweepRay({
        players: this.playerManager,
        field: getHeightfield(),
        solids: this.projectiles.solidColliders,
      }, pid, muzzle, dir, range),
    // Movement reconciles like dedicated: inputs queue on the shadow,
    // reports judge it, resync/energy ride the same hooks.
    moveInput: (pid, i, status, seq) => this.moveShadows.queueInput(pid, {
      forward: i.forward, right: i.right,
      jumpPressed: !!i.jump, jumpHeld: !!i.jump, skiHeld: !!i.ski,
      jetHeld: !!i.jet,
    }, status, seq),
    moveReport: (pid, pos, yaw, vel, inputSeq, rttMs) => this.moveShadows.reconcile(pid, pos, yaw, vel, inputSeq, rttMs),
    inputSeqOf: (pid) => this.moveShadows.inputSeqOf(pid),
    drainEnergy: (pid, n) => this.moveShadows.drainEnergy(pid, n),
    onSkillUse: (pid) => this.moveShadows.drainEnergy(pid, ENERGY.skillCost) ? true : 'gone',
    energyOf: (pid) => this.moveShadows.energyOf(pid),
    moveResync: (pid, pos, yaw, fullEnergy) => this.moveShadows.resync(pid, pos, yaw, fullEnergy),
    moveTrack: (pid, pos, yaw) => {
      const p = this.playerManager.getPlayer(pid);
      this.moveShadows.track(pid, pos, yaw, p?.perk, p?.team);
      this.moveShadows.markReseated(pid);
    },
    moveMute: (pid) => this.moveShadows.markReseated(pid),
    moveUntrack: (pid) => this.moveShadows.untrack(pid),
  };

  /** The host's own world — guests must build THIS terrain/structures,
   *  not whatever map they last saved. Called once the boot map resolves;
   *  gameState map fields read it at handshake. */
  setMap(map: {
    structures?: import('../../../../shared/mapSpec.js').StructureSpec[];
    arena?: { x: number; z: number; radius: number } | null;
    ambient?: Record<string, number>;
    terrain?: string;
    heightScale?: number;
    tileSize?: number;
    fog?: { color: [number, number, number]; distance?: number; visible?: number };
    terrainTex?: string;
    sky?: string;
    interiors?: import('../../../../shared/mapSpec.js').InteriorSpec[];
    spawns?: import('../../../../shared/mapSpec.js').MapSpec['spawns'];
    teamSpawns?: import('../../../../shared/mapSpec.js').MapSpec['teamSpawns'];
    bases?: RoomInfo['bases'];
  } | null): void {
    if (!map) {return;}
    this.roomInfo.structures = map.structures;
    this.roomInfo.arena = map.arena ?? undefined;
    this.roomInfo.ambient = map.ambient;
    this.roomInfo.terrain = map.terrain;
    this.roomInfo.heightScale = map.heightScale;
    this.roomInfo.tileSize = map.tileSize;
    this.roomInfo.fog = map.fog;
    this.roomInfo.terrainTex = map.terrainTex;
    this.roomInfo.sky = map.sky;
    this.roomInfo.interiors = map.interiors;
    // Authored spawn anchors — the host assigns spawn positions, so a
    // spec map should land guests where the map says, not at origin.
    if (map.spawns) this.playerManager.spawnPoints = map.spawns;
    if (map.teamSpawns) this.playerManager.teamSpawns = map.teamSpawns;
    this.roomInfo.bases = map.bases;
  }

  constructor() {
    this.projectiles = new RoomProjectiles(this, null);
    this.playerManager.energyBurn = (pid, n) => this.moveShadows.drainEnergy(pid, n);
    this.messageHandler = new MessageHandler(
      this.playerManager,
      this.rateLimiter,
      (msg, exclude) => this.broadcast(msg, exclude),
      (pid, msg) => this.sendJSON(pid, msg),
      this.roomInfo,
    );

    // 20Hz to match the dedicated server's tick cadence. With two players
    // there's no interest management — every frame carries the one peer.
    // The beat comes from a Worker: window setInterval throttles to ~1Hz
    // in a hidden tab, which would stall the session for the guest on
    // every host alt-tab. Worker timers survive; fall back if unavailable.
    try {
      this.tickClock = new Worker(new URL('./tickClock.ts', import.meta.url), { type: 'module' });
      this.tickClock.onmessage = () => this.tick();
    } catch {
      logger.warn('Worker clock unavailable — host tick will throttle while the tab is hidden');
      this.tickTimer = setInterval(() => this.tick(), 50);
    }
  }

  /** Wire a guest's DataChannel in as a link — same treatment as the
   *  host's own loopback after this point. */
  attachDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    const link: P2PLink = {
      send: (data) => {
        if (dc.readyState !== 'open') {return;}
        if (typeof data === 'string') {dc.send(data);}
        else {dc.send(new Uint8Array(data));}
      },
      close: () => { try { dc.close(); } catch { /* gone */ } },
    };
    dc.addEventListener('message', (ev) => {
      const {data} = ev;
      this.onData(link, data instanceof ArrayBuffer ? new Uint8Array(data) : data as string);
    });
    dc.addEventListener('close', () => this.onClose(link));
    logger.info('Guest DataChannel attached');
  }

  /** A peer's outbound message (JSON string or binary position frame). */
  onData(link: P2PLink, data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      if (!isWireFrame(data)) {return;}
      const playerId = this.links.get(link);
      if (!playerId) {return;} // binary before join — ignore
      const pos = decodePosition(data);
      if (pos) {this.dispatch(playerId, pos);}
      return;
    }

    let raw: unknown;
    try { raw = JSON.parse(data); } catch { return; }

    const playerId = this.links.get(link);
    if (!playerId) {
      // First message on a link must be the join handshake
      const msg = raw as { type?: string; playerId?: unknown };
      if (msg.type === 'join') {this.handleJoin(link, msg.playerId);}
      return;
    }
    this.dispatch(playerId, raw);
  }

  onClose(link: P2PLink): void {
    const playerId = this.links.get(link);
    if (!playerId) {return;}
    this.links.delete(link);
    this.byPlayer.delete(playerId);
    // No grace period on P2P — a dead socket is a leave, full stop.
    this.messageHandler.onPlayerDisconnected(playerId);
    this.messageHandler.onPlayerRemoved(playerId);
    this.rateLimiter.removePlayer(playerId);
    this.playerManager.removePlayer(playerId);
    this.broadcast({ type: 'playerLeft', playerId });
    logger.info('P2P peer left', { playerId });
  }

  private handleJoin(link: P2PLink, rawId: unknown): void {
    const res = validatePlayerId(rawId);
    if (!res.success) { link.close(); return; }
    const playerId = res.data;

    // Same id rejoining on a fresh link (guest reloaded): evict the old
    // one so the roster doesn't double.
    const stale = this.byPlayer.get(playerId);
    if (stale) { this.onClose(stale); stale.close(); }

    this.playerManager.addPlayer(playerId);
    this.links.set(link, playerId);
    this.byPlayer.set(playerId, link);
    // Session tokens are a server concept — P2P links are already
    // mutually authenticated by the room code, so a static token suffices.
    this.messageHandler.handleHandshake(playerId, 'p2p', false);
    logger.info('P2P peer joined', { playerId });
  }

  private dispatch(playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {return;}
    this.messageHandler.handleMessage(playerId, result.data);
  }

  broadcast(msg: ServerMessage, excludePlayerId?: string): void {
    const text = JSON.stringify(msg);
    for (const [link, pid] of this.links) {
      if (pid === excludePlayerId) {continue;}
      try { link.send(text); } catch { /* one dead pipe mustn't sink the tick */ }
    }
  }

  private sendJSON(playerId: string, msg: ServerMessage): void {
    const link = this.byPlayer.get(playerId);
    if (!link) {return;}
    try { link.send(JSON.stringify(msg)); } catch { /* dead pipe */ }
  }

  private tick(): void {
    // Terrain loads after connect — attach the first non-null field once
    // (attachField rescans the whole map, so this isn't a per-tick call).
    if (!this.fieldAttached) {
      const f = getHeightfield();
      if (f) {
        this.projectiles.attachField(f);
        this.moveShadows.attachField(f, (pid) => this.playerManager.getPlayer(pid)?.position);
        this.fieldAttached = true;
      }
    }
    // Shells fly even with one player — the host fires before guests join.
    this.projectiles.tick(0.05);
    this.moveShadows.tick(0.05);
    if (this.byPlayer.size < 2) {return;}
    const players = this.playerManager.getAllPlayers();
    for (const [recipientId] of players) {
      const link = this.byPlayer.get(recipientId);
      if (!link) {continue;}
      const records: Uint8Array[] = [];
      for (const [pid, p] of players) {
        if (pid === recipientId) {continue;}
        records.push(encodeTickPlayer({
          playerId: pid,
          position: p.position,
          rotation: p.rotation,
          velocity: p.velocity,
          health: p.health,
          isDead: p.isDead,
          ping: p.ping > 0 ? p.ping : undefined,
          ski: p.skiing,
        }));
      }
      if (records.length === 0) {continue;}
      // inputAck=0: the P2P host tracks no per-player input seqs — clients
      // ignore 0 (never prune on it).
      try { link.send(encodeTickFrame(this.playerManager.getLastSeq(recipientId), this.tickSeq++, 0, records)); } catch { /* dead pipe */ }
    }
  }

  stop(): void {
    if (this.tickTimer !== null) {clearInterval(this.tickTimer);}
    this.tickClock?.postMessage('stop');
    this.tickClock?.terminate();
    this.tickClock = null;
  }
}
