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
import { isWireFrame, decodePosition, decodeInputMove, decodeWireJson, decodePosClaim, decodeShot, encodeTickPlayer, encodeTickFrame, WIRE_INPUTMOVE, WIRE_JSON, WIRE_JUMP, WIRE_JETPACK, WIRE_SHOT , type WirePosition } from '../../../../shared/wire.js';
import { wallMs } from '../../../../shared/clockBrand.js';
import type { ServerMessage } from '../../../../shared/protocol.js';
import { ChildLogger } from '../../core/Logger.js';
import { RoomProjectiles } from '../../../../server_bun/src/RoomProjectiles.js';
import { RoomMoveSim } from '../../../../server_bun/src/RoomMoveSim.js';
import { ENERGY, MOVEMENT_CONFIG } from '../../../../shared/movement.js';
import { perkMods } from '../../../../shared/perks.js';
import { beamSweepRay } from '../../../../server_bun/src/beamSweep.js';
import { healPerTick } from '../../../../server_bun/src/tickHelpers.js';
import { healPool } from '../../../../server_bun/src/healPool.js';
import { lgChargeAt } from '../../../../shared/combat.js';
import { simNow } from '../../../../server_bun/src/simClock.js';
import { getHeightfield } from '../../world/heightmap.js';
import type { StructureSpec,InteriorSpec,WeatherSpec,AtmosphereSpec,WaterSpec,MapSpec } from '../../../../shared/mapSpec.js';

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
  /** Per-link decode slot — position frames are the host's hottest
   *  inbound path; consumers copy field-wise within dispatch. */
  private decodeScratch = new Map<P2PLink, WirePosition>();
  private byPlayer = new Map<string, P2PLink>();
  private pingCycle = 0;
  /** Stamp of the ping each guest last received — pongs that don't echo
   *  an issued stamp are dropped (spoofed-RTT gate, same as dedicated). */
  private lastPingStamp = new Map<string, number>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickClock: Worker | null = null;
  tickSeq = 0;
  /** ProjHost surface — the weapon sims run on this host exactly as they
   *  do on a Room; `this` IS the room to RoomProjectiles. */
  readonly mode = 'p2p';
  private fieldAttached = false;

  get players(): PlayerManager { return this.playerManager; }
  get messages(): MessageHandler { return this.messageHandler; }
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
    // Effective spawn pools for the debug map layer — live thunks like
    // the dedicated room's, since setMap re-points them after ctor.
    spawns: () => this.playerManager.spawnPoints,
    teamSpawns: () => this.playerManager.teamSpawns,
    fireProjectile: (pid, wt, origin, dir, vel, shotId): string | null =>
      this.projectiles.spawn(pid, wt, origin, dir, vel, shotId),
    beamSweep: (pid, muzzle, dir, range) =>
      beamSweepRay({
        players: this.playerManager,
        field: getHeightfield(),
        solids: this.projectiles.solidColliders,
        transitOf: (tpid): number => this.moveShadows.transitOf(tpid),
      }, pid, muzzle, dir, range),
    // Movement reconciles like dedicated: inputs queue on the shadow,
    // reports judge it, resync/energy ride the same hooks.
    moveInput: (pid, i, status, seq): boolean => this.moveShadows.queueInput(pid, {
      forward: i.forward, right: i.right,
      jumpPressed: Boolean(i.jump), jumpHeld: Boolean(i.jump), skiHeld: Boolean(i.ski),
      jetHeld: Boolean(i.jet),
    }, status, seq),
    moveReport: (pid, pos, yaw, vel, inputSeq, rttMs) => this.moveShadows.reconcile(pid, pos, yaw, vel, inputSeq, rttMs),
    inputSeqOf: (pid): number => this.moveShadows.inputSeqOf(pid),
    transitOf: (pid): number => this.moveShadows.transitOf(pid),
    transitNote: (pid, rtt, stamp): void => {
      if (this.lastPingStamp.get(pid) !== stamp) {return;}
      this.moveShadows.feedTransit(pid, rtt);
    },
    drainEnergy: (pid, n): boolean => this.moveShadows.drainEnergy(pid, n),
    onSkillUse: (pid): true | "gone" => this.moveShadows.drainEnergy(pid, ENERGY.skillCost) ? true : 'gone',
    energyOf: (pid): number | null => this.moveShadows.energyOf(pid),
    moveResync: (pid, pos, yaw, fullEnergy): void => this.moveShadows.resync(pid, pos, yaw, fullEnergy),
    moveTrack: (pid, pos, yaw): void => {
      const p = this.playerManager.getPlayer(pid);
      this.moveShadows.track(pid, pos, yaw, p?.perk, p?.team);
      this.moveShadows.markReseated(pid);
    },
    moveMute: (pid): void => this.moveShadows.markReseated(pid),
    moveUntrack: (pid): void => this.moveShadows.untrack(pid),
  };

  /** The host's own world — guests must build THIS terrain/structures,
   *  not whatever map they last saved. Called once the boot map resolves;
   *  gameState map fields read it at handshake. */
  setMap(map: {
    structures?: StructureSpec[];
    arena?: { x: number; z: number; radius: number } | null;
    killY?: number;
    ambient?: Record<string, number>;
    terrain?: string;
    heightScale?: number;
    tileSize?: number;
    fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] };
    water?: WaterSpec;
    terrainTex?: string;
    terrainPreset?: number;
    sky?: string;
    weather?: WeatherSpec;
    atmosphere?: AtmosphereSpec;
    interiors?: InteriorSpec[];
    spawns?: MapSpec['spawns'];
    teamSpawns?: MapSpec['teamSpawns'];
    bases?: RoomInfo['bases'];
  } | null): void {
    if (!map) {return;}
    this.roomInfo.structures = map.structures;
    this.roomInfo.arena = map.arena ?? undefined;
    this.roomInfo.killY = map.killY;
    this.moveShadows.setKillY(map.killY);
    this.roomInfo.ambient = map.ambient;
    this.roomInfo.terrain = map.terrain;
    this.roomInfo.heightScale = map.heightScale;
    this.roomInfo.tileSize = map.tileSize;
    this.roomInfo.fog = map.fog;
    this.roomInfo.water = map.water;
    this.roomInfo.terrainTex = map.terrainTex;
    this.roomInfo.terrainPreset = map.terrainPreset;
    this.roomInfo.sky = map.sky;
    this.roomInfo.weather = map.weather;
    this.roomInfo.atmosphere = map.atmosphere;
    this.roomInfo.interiors = map.interiors;
    // Authored spawn anchors — the host assigns spawn positions, so a
    // spec map should land guests where the map says, not at origin.
    if (map.spawns) {this.playerManager.spawnPoints = map.spawns;}
    if (map.teamSpawns) {this.playerManager.teamSpawns = map.teamSpawns;}
    this.roomInfo.bases = map.bases;
    // setMap arrives after construction — both collider sets must track
    // the host's real map or beam sweeps + shell contacts adjudicate
    // against a world the guests don't live in.
    this.messageHandler.attachStructures(map.structures);
    this.projectiles.attachStructures(map.structures);
    // Third sink, same class: the move shadow sims guests against the
    // host's collider set — without it a guest who slides off a wall
    // reports a position the shadow can't reproduce (phantom resyncs).
    this.moveShadows.attachStructures(map.structures);
    this.moveShadows.setWaterLevel(map.water?.swim === false ? undefined : map.water?.level);
  }

  constructor() {
    this.projectiles = new RoomProjectiles(this, null);
    this.playerManager.energyBurn = (pid, n): boolean => this.moveShadows.drainEnergy(pid, n);
    // Same shadow-measured T1 fall damage as dedicated — the guest's
    // 'landed' echo dresses the slam for observers either way.
    this.moveShadows.onLanding = (pid, impact): void => {
      const p = this.playerManager.getPlayer(pid);
      if (!p || p.isDead) {return;}
      this.broadcast({ type: 'landed', playerId: pid, pos: p.position, impact });
      let dmg = (impact - MOVEMENT_CONFIG.fallDamageMinSpeed) * MOVEMENT_CONFIG.fallDamageScale * p.maxHealth;
      const soak = perkMods(p.perk).fallSoak;
      if (soak > 0) {
        const covered = Math.min(dmg, (this.moveShadows.energyOf(pid) ?? 0) * soak);
        if (covered > 0) {this.moveShadows.drainEnergy(pid, covered / soak); dmg -= covered;}
      }
      if (dmg >= p.maxHealth * MOVEMENT_CONFIG.fallDamageAbsorbFrac) {this.messageHandler.fallDamage(pid, dmg);}
    };
    // Kill zone — the shadow measured the body below the map's floor.
    this.moveShadows.onKillZone = (pid): void => {
      const p = this.playerManager.getPlayer(pid);
      if (!p || p.isDead) {return;}
      this.messageHandler.killZone(pid, p.maxHealth);
    };
    this.messageHandler = new MessageHandler(
      this.playerManager,
      this.rateLimiter,
      (msg, exclude): void => this.broadcast(msg, exclude),
      (pid, msg): void => this.sendJSON(pid, msg),
      this.roomInfo,
    );

    // 20Hz to match the dedicated server's tick cadence. With two players
    // there's no interest management — every frame carries the one peer.
    // The beat comes from a Worker: window setInterval throttles to ~1Hz
    // in a hidden tab, which would stall the session for the guest on
    // every host alt-tab. Worker timers survive; fall back if unavailable.
    try {
      this.tickClock = new Worker(new URL('./tickClock.ts', import.meta.url), { type: 'module' });
      this.tickClock.addEventListener('message', (): void => this.tick());
    } catch {
      logger.warn('Worker clock unavailable — host tick will throttle while the tab is hidden');
      this.tickTimer = setInterval((): void => this.tick(), 50);
    }
  }

  /** Wire a guest's DataChannel pair in as a link — same treatment as the
   *  host's own loopback after this point. 'game' (unordered, bounded
   *  retransmit) carries volatile binary; 'ctrl' (reliable+ordered)
   *  carries JSON — same split the dedicated RTC lanes use, since an
   *  ordered channel head-of-line blocks position frames on every loss. */
  attachDataChannels(chans: { game: RTCDataChannel; ctrl: RTCDataChannel }): void {
    const link: P2PLink = {
      send: (data): void => {
        const want = typeof data === 'string' ? chans.ctrl : chans.game;
        const alt = typeof data === 'string' ? chans.game : chans.ctrl;
        const dc = want.readyState === 'open' ? want : alt.readyState === 'open' ? alt : null;
        if (!dc) {return;}
        if (typeof data === 'string') {dc.send(data);}
        else {dc.send(new Uint8Array(data));}
      },
      close: (): void => {
        for (const dc of [chans.game, chans.ctrl]) {try { dc.close(); } catch { /* gone */ }}
      },
    };
    for (const dc of [chans.game, chans.ctrl]) {
      dc.binaryType = 'arraybuffer';
      dc.addEventListener('message', (ev): void => {
        const {data} = ev;
        this.onData(link, data instanceof ArrayBuffer ? new Uint8Array(data) : data as string);
      });
      // A lane dying kills the session — onClose no-ops on a gone link,
      // so firing it from both lanes is safe.
      dc.addEventListener('close', (): void => this.onClose(link));
    }
    logger.info('Guest DataChannels attached');
  }

  /** A peer's outbound message (JSON string or binary wire frame). */
  onData(link: P2PLink, data: string | Uint8Array): void {
    if (typeof data !== 'string') {this.onBinary(link, data); return;}

    // oxlint-disable-next-line init-declarations -- assigned later
    let raw!: unknown;
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
    this.decodeScratch.delete(link);
    this.byPlayer.delete(playerId);
    this.lastPingStamp.delete(playerId);
    // No grace period on P2P — a dead socket is a leave, full stop.
    this.messageHandler.onPlayerDisconnected(playerId);
    this.messageHandler.onPlayerRemoved(playerId);
    this.rateLimiter.removePlayer(playerId);
    // A leaver's live shells die with them — same ownership rule the
    // dedicated Room applies (sticky/mortar bodies otherwise linger to TTL).
    this.projectiles.clearOwner(playerId);
    this.playerManager.removePlayer(playerId);
    this.broadcast({ type: 'playerLeft', playerId });
    logger.info('P2P peer left', { playerId });
  }

  private freshPosSlot(link: P2PLink): WirePosition {
    const slot = {
      type: 'position',
      position: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      seq: 0, ping: 0,
    } as WirePosition;
    this.decodeScratch.set(link, slot);
    return slot;
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

  /** Binary lane: same opcode fan-out the dedicated socket path runs
   *  (GameServer.onBinary). Without it every FAST_LANE claim - teleport,
   *  shots, aoeShot, deploy, skillUse, inputMove edges - would decode as
   *  a position, fail, and drop silently. */
  private onBinary(link: P2PLink, data: Uint8Array): void {
    if (!isWireFrame(data)) {return;}
    const playerId = this.links.get(link);
    if (!playerId) {return;} // binary before join — ignore
    if (data[1] === WIRE_JSON) {
      const text = decodeWireJson(data);
      if (text !== null) {this.onData(link, text);}
      return;
    }
    if (data[1] === WIRE_JUMP || data[1] === WIRE_JETPACK) {
      const c = decodePosClaim(data, data[1]!);
      if (c) {this.trusted(playerId, { type: data[1] === WIRE_JUMP ? 'jump' : 'jetpack', position: c.position });}
      return;
    }
    if (data[1] === WIRE_SHOT) {
      const s = decodeShot(data);
      if (s) {this.trusted(playerId, { type: 'shotFired', weaponType: s.weaponType, pos: s.pos, dir: s.dir, shotId: s.shotId, fireAt: s.fireAt });}
      return;
    }
    if (data[1] === WIRE_INPUTMOVE) {
      const im = decodeInputMove(data);
      if (im) {this.trusted(playerId, im);}
      return;
    }
    const pos = decodePosition(data, this.decodeScratch.get(link) ?? this.freshPosSlot(link));
    if (pos) {this.trusted(playerId, pos);}
  }

  /** Binary-decoded frames were shape+range-checked at the byte boundary —
   *  same trusted dispatch the dedicated socket path gives them. */
  private trusted(playerId: string, msg: Parameters<MessageHandler['handleMessage']>[1]): void {
    try {
      this.messageHandler.handleMessage(playerId, msg, undefined, true);
    } catch (error) {
      logger.error('Handler failed', { playerId, type: (msg as { type?: string })?.type ?? '?', err: error instanceof Error ? error.stack ?? error.message : String(error) });
      this.byPlayer.get(playerId)?.close();
    }
  }

  private dispatch(playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {return;}
    // Same containment as GameServer.onMessage — a throwing handler must
    // only cost the offending peer's link, never the host's own game.
    try {
      this.messageHandler.handleMessage(playerId, result.data);
    } catch (error) {
      logger.error('Handler failed', { playerId, type: (result.data as { type?: string })?.type ?? '?', err: error instanceof Error ? error.stack ?? error.message : String(error) });
      this.byPlayer.get(playerId)?.close();
    }
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
    // Same RTT probe the dedicated Room runs — the move shadow's transit
    // EMA needs a channel guests can't fabricate (their reported ping
    // rides every position frame).
    if ((this.pingCycle += 1) % 10 === 0 && this.byPlayer.size > 0) {
      const ids = [...this.byPlayer.keys()];
      const pid = ids.find((id): boolean => !this.lastPingStamp.has(id))
        ?? ids[(Math.trunc(this.pingCycle / 10)) % ids.length]!;
      const stamp = Date.now();
      this.lastPingStamp.set(pid, stamp);
      this.sendJSON(pid, { type: 'ping', timestamp: stamp });
    }
    // Server-owned heal channels + charge bank — the dedicated fanout
    // ticks these inside buildRecords; the host must too or a guest's
    // medkit/regen never repairs their authoritative hp (and their
    // charge bank never crackles). Own player ticks too: the shared
    // PlayerState is the truth hits resolve against.
    const simT = simNow();
    const now = Date.now();
    for (const [pid, p] of this.playerManager.getAllPlayers()) {
      const heal = healPerTick(p, simT);
      if (heal > 0) {
        healPool(p, heal);
        if (now - p.healthEchoAt >= 500 || p.health >= p.maxHealth) {
          p.healthEchoAt = wallMs(now);
          this.sendJSON(pid, { type: 'yourHealth', health: p.health });
        }
      }
      const acc = lgChargeAt(p.charge, p.chargeT, simT / 1000);
      const live = acc > 0.5;
      if ((live || p.chargeEchoed > 0) && (!live || now - p.chargeEchoAt >= 500)) {
        p.chargeEchoAt = wallMs(now);
        p.chargeEchoed = live ? acc : 0;
        this.sendJSON(pid, { type: 'yourCharge', charge: p.chargeEchoed });
      }
    }
    if (this.byPlayer.size < 2) {return;}
    const players = this.playerManager.getAllPlayers();
    // tickSeq advances once per TICK, not per recipient — incrementing
    // inside the loop gave every client a gapped stream (0,2,4,...) that
    // read as ~50% loss and spammed tickNack all session.
    const frameSeq = (this.tickSeq += 1) - 1;
    for (const [recipientId] of players) {
      const link = this.byPlayer.get(recipientId);
      if (!link) {continue;}
      const records: Uint8Array[] = [];
      for (const [pid, p] of players) {
        if (pid === recipientId) {continue;}
        // Lead the broadcast by the sender's uplink transit, same as
        // TickLoop — a hosted room otherwise renders everyone ~ping
        // behind where they actually are (the ghost-aim pattern).
        const lead = Math.min(this.moveShadows.transitOf(pid) / 2000, 0.3);
        records.push(encodeTickPlayer({
          playerId: pid,
          position: {
            x: p.position.x + p.velocity.x * lead,
            y: p.position.y + p.velocity.y * lead,
            z: p.position.z + p.velocity.z * lead,
          },
          rotation: p.rotation,
          velocity: p.velocity,
          health: p.health,
          isDead: p.isDead,
          ping: p.ping > 0 ? p.ping : undefined,
          ski: p.skiing,
          jet: p.jetting,
          // Without this guests' remotes decode status:0 — cloak/regen
          // visuals never reach a hosted room.
          status: p.status,
        }));
      }
      if (records.length === 0) {continue;}
      // inputAck=0: the P2P host tracks no per-player input seqs — clients
      // ignore 0 (never prune on it).
      try { link.send(encodeTickFrame(this.playerManager.getLastSeq(recipientId), frameSeq, 0, records)); } catch { /* dead pipe */ }
    }
  }

  stop(): void {
    if (this.tickTimer !== null) {clearInterval(this.tickTimer);}
    this.tickClock?.postMessage('stop');
    this.tickClock?.terminate();
    this.tickClock = null;
  }
}
