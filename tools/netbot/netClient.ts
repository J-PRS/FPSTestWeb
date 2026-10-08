// Headless game client — connects to a running server over a REAL
// WebSocket, speaks the real shared/protocol + wire codec, and keeps the
// same client-side bookkeeping the browser client does (roster, per-room
// seq watermarks, claim→projectile binding). The behavior layer lives in
// bot.ts; this file is transport + state.

import type { ClientMessage, ServerMessage, TickUpdatePlayer, Vec3 } from '../../shared/protocol.ts';
import { decodeTickFrame, isWireFrame } from '../../shared/wire.ts';
import { hmParseBin, type Heightfield } from '../../shared/heightfield.ts';
import { FieldSurface } from '../../shared/fieldSurface.ts';
import { SolidWorld } from '../../shared/solidWorld.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';

import { fileURLToPath } from 'node:url';
import { LatencyLink } from './latency.ts';
import { RtcGameSocket, type BotSocket, type NdModule } from './rtcSocket.ts';

export interface RemoteEntry {
  pos: Vec3;
  vel: Vec3;
  health: number;
  isDead: boolean;
  team?: string;
  /** Armor tier — squad role weighting reads kit, not just ids. */
  cls?: string;
}

export interface NetTelemetry {
  hitsDealt: number;
  hitsTaken: number;
  kills: number;
  deaths: number;
  shots: number;
  claims: number;
  rejects: Map<string, number>;
  corrections: number;
  gameStates: number;
  /** Accepted tick frames — stream-liveness signal per client. */
  ticks: number;
  hops: number;
  dedupDrops: number;
  /** Brain fire intents and which gate each died on — the difference
   *  between "never chose to shoot" and "chose but couldn't claim". */
  fireIntents: number;
  fireBlocked: Map<string, number>;
}

const EVENT_TYPES = new Set(['playerHit', 'playerKill', 'playerRespawn', 'shotRejected', 'correction', 'yourHealth']);

// Minimal structural socket — a real WebSocket and RtcGameSocket both fit.
// Handler props are `unknown` so each side can keep its own event shape;
// connect() assigns them once with locally-typed callbacks.
type AnySocket = BotSocket & {
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
};

export class NetClient {
  readonly id: string;
  ws: AnySocket | null = null;
  link: LatencyLink;
  tel: NetTelemetry = {
    hitsDealt: 0, hitsTaken: 0, kills: 0, deaths: 0,
    shots: 0, claims: 0, rejects: new Map(), corrections: 0,
    gameStates: 0, ticks: 0, hops: 0, dedupDrops: 0,
    fireIntents: 0, fireBlocked: new Map(),
  };

  /** Self state — pos driven by bot locomotion (position channel), the
   *  rest adopted from server events exactly like the browser client. */
  self = { pos: { x: 0, y: 60, z: 0 } as Vec3, vel: { x: 0, y: 0, z: 0 } as Vec3, health: 100, isDead: false, team: undefined as string | undefined };
  roster = new Map<string, RemoteEntry>();
  /** shotId → server projectile id, learned from projectileCreated echoes. */
  projectiles = new Map<string, string>();
  /** Deployables visible in this room — deploySpawn/Gone/Hp plus the
   *  gameState snapshot, same lifecycle as the browser's deploy layer. */
  deployables = new Map<number, { owner: string; kind: string; pos: Vec3; hp: number }>();
  /** CTF flag states by team — gameState.flags + flagUpdate. */
  flags = new Map<string, { pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }>();
  /** Server-owned creatures — ballRoster/ballSegment and crawlRoster/
   *  crawlEvt streams, same lifecycle as the browser's creature layer. */
  balls = new Map<number, RemoteEntry>();
  crawlers = new Map<number, RemoteEntry>();
  /** Per-room hit seq watermark — same rule as the browser client: reset
   *  on every gameState so a room hop can't drop the new seq space. */
  private lastHitSeq = 0;
  private lastTickSeq = -1;
  /** True between switchRoom and the new room's gameState — gameplay
   *  sends during the gap carry the OLD room's position, which the new
   *  room's server rightly rejects as an implausible spawn. */
  private pendingRoom = false;
  /** True only after a gameState arrives on THIS socket — tel.gameStates
   *  is cumulative across reconnects, so gating join/gameplay on it
   *  would let a fresh socket emit gameplay before its handshake and
   *  get closed on the spot. */
  private joined = false;
  /** Server-issued seat token — reclaiming a grace-period slot (or any
   *  already-claimed id) requires presenting it in the next join, same
   *  as the browser client's localStorage 'fps-session-token' path. */
  private sessionToken?: string;
  /** Terrain the room's sims run on — bot locomotion steps a real MoveSim
   *  against it so reports and the server's shadow sim replay the same
   *  physics; without it a bot's eased positions read as airborne drift. */
  field: Heightfield | null = null;
  surface: FieldSurface | null = null;
  /** Last incoming hit + the shooter's roster position at that moment —
   *  the pain signal a real player reacts to (server bots get it via
   *  brain.takeHit off the combat funnel). */
  lastAttacker: { at: number; shooterId: string | undefined } | null = null;
  /** Behavior-layer hook for claim verdicts — a reject is a verdict, not
   *  transport loss, so the bot stops retransmitting that spawn. */
  onShotRejected?: (m: Extract<ServerMessage, { type: 'shotRejected' }>) => void;
  /** Same hook for honest-lag discards — the claim is dead server-side,
   *  re-firing it only burns the fire window. */
  onClaimDropped?: (m: Extract<ServerMessage, { type: 'claimDropped' }>) => void;
  /** Behavior-layer hook for world resyncs — a gameState means the world
   *  may have moved on without us (grace-gap knockback/kills), so claims
   *  queued before it are stale the same way pre-hop claims are. */
  onGameState?: () => void;
  /** Structures from gameState/mapUpdate — stashed until the field
   *  finishes loading so the attach survives a slow .bin fetch. */
  private structures?: readonly StructureSpec[];
  private attachStructures(list: readonly StructureSpec[]): void {
    this.structures = list;
    if (this.surface) this.surface.solid = list.length ? SolidWorld.fromSpecs(list) : null;
  }
  private fieldPromise: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private joinTimer: ReturnType<typeof setInterval> | null = null;
  pingMs = 0;
  closed = false;
  closeInfo = '';

  constructor(private url: string, id: string, link?: LatencyLink, private joinOpts: { room?: string; mode?: string; transport?: 'ws' | 'rtc'; bots?: number; armorClass?: string; rtc?: { nd: NdModule; iceServers?: { hostname: string; port: number; relayer?: boolean }[] } } = {}) {
    this.id = id;
    this.link = link ?? new LatencyLink({ pingMs: 0, jitterMs: 0, lossRate: 0 });
  }

  async connect(): Promise<void> {
    const transport = this.joinOpts.transport ?? 'ws';
    const ws: AnySocket = transport === 'rtc'
      ? await this.dialRtc()
      : new WebSocket(this.url);
    if (ws instanceof WebSocket) ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.joined = false;
    this.closed = false;
    this.closeInfo = '';
    return new Promise((resolve, reject) => {
      // RTC fires per-channel open (game + ctrl) — arm the handshake once.
      let opened = false;
      ws.onopen = () => {
        if (opened) return;
        opened = true;
        // Join retries until the first gameState lands — a swallowed or
        // throttled join would otherwise leave the bot a silent ghost,
        // the same failure a real client's retry button papers over.
        const joinMsg = JSON.stringify({ type: 'join', playerId: this.id, transport, token: this.sessionToken, room: this.joinOpts.room, mode: this.joinOpts.mode, bots: this.joinOpts.bots, armorClass: this.joinOpts.armorClass });
        ws.send(joinMsg);
        let tries = 0;
        this.joinTimer = setInterval(() => {
          if (this.joined || ++tries > 10) { if (this.joinTimer) clearInterval(this.joinTimer); return; }
          // The handshake bypasses the latency link — jittering the join
          // would let gameplay messages beat it, and the server rightly
          // closes any socket whose first word isn't 'join'.
          if (ws.readyState === 1) {
            ws.send(joinMsg);
          }
        }, 400);
        this.pingTimer = setInterval(() => this.send({ type: 'ping', timestamp: Date.now() }), 2000);
        resolve();
      };
      ws.onmessage = (ev: { data: string | ArrayBuffer }) => {
        if (typeof ev.data === 'string') this.onMessage(JSON.parse(ev.data) as ServerMessage);
        else this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = (ev: { code: number; reason: string }) => { this.closed = true; this.closeInfo = `${ev.code} ${ev.reason}`; };
      ws.onerror = () => reject(new Error(`netbot ${this.id} ${transport} error`));
      // RtcGameSocket.dial resolves only after a channel opened — the open
      // event fired before these handlers existed, so re-arm manually.
      if (ws.readyState === 1) (ws.onopen as () => void)?.();
    });
  }

  private async dialRtc(): Promise<RtcGameSocket> {
    const rtc = this.joinOpts.rtc;
    if (!rtc) throw new Error('netbot rtc transport needs joinOpts.rtc.nd injected');
    return RtcGameSocket.dial(this.url.replace(/\/ws$/, '/rtcs'), rtc.nd, rtc.iceServers ?? []);
  }

  /** Fetch the room's heightfield the way the browser does — the gameState
   *  names a maps/<file>.bin the server also serves over HTTP. A spec-less
   *  room falls back to the server's default field file read off disk,
   *  the same one GameServer itself boots with. */
  private async loadField(terrain?: string, heightScale = 1): Promise<void> {
    try {
      let buf: Uint8Array | null = null;
      if (terrain) {
        const base = this.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
        const res = await fetch(`${base}/maps/${terrain}`);
        if (res.ok) buf = new Uint8Array(await res.arrayBuffer());
      }
      if (!buf) {
        const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
        const ab = await bunFile?.(fileURLToPath(new URL('../../server_bun/heightmap.bin', import.meta.url)))?.arrayBuffer().catch(() => null);
        if (ab) buf = new Uint8Array(ab);
      }
      if (!buf || buf.byteLength < 9) return;
      const field = hmParseBin(buf, heightScale);
      this.field = field;
      // Same FieldSurface the server shadow integrates on — terrain-only
      // sims diverge exactly where a wall one side can't see stands.
      this.surface = FieldSurface.fromField(field);
      if (this.structures?.length) this.surface.solid = SolidWorld.fromSpecs(this.structures);
    } catch {
      // No terrain — the bot stays on flat-world kinematics.
    }
  }

  /** All outbound traffic flows through the latency shim — combat claims
   *  take the full jitter (unordered transport), steady=true pins a fixed
   *  half-ping so a channel stays ordered. */
  send(msg: ClientMessage, steady = false): void {
    if (msg.type === 'switchRoom') this.pendingRoom = true;
    // Gameplay sends are gated on the join handshake landing — the server
    // closes any socket whose first word isn't 'join', so a jittered ping
    // or position arriving early would kill the connection outright.
    if (!this.ws || !this.joined || (this.pendingRoom && msg.type !== 'switchRoom')) return;
    this.link.send(this.ws, JSON.stringify(msg), steady);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.joinTimer) clearInterval(this.joinTimer);
    this.link.close();
    this.ws?.close();
  }

  /** v3 roster: u16 -> playerId — gameState snapshot + 'wireIds' deltas. */
  private readonly wireIds = new Map<number, string>();
  private readonly tickPool = { slots: [] as never[], resolveId: (id: number) => this.wireIds.get(id) };

  private onBinary(u8: Uint8Array): void {
    if (!isWireFrame(u8)) return;
    const tick = decodeTickFrame(u8, this.tickPool as never);
    if (!tick) return;
    if (tick.tickSeq <= this.lastTickSeq) return; // stale frame, same rule as the client
    this.lastTickSeq = tick.tickSeq;
    this.tel.ticks++;
    this.applyTick(tick.updates);
  }

  private applyTick(updates: TickUpdatePlayer[]): void {
    for (const u of updates) {
      if (!u.playerId || u.playerId === this.id) continue;
      const e = this.roster.get(u.playerId) ?? { pos: { ...u.position }, vel: { x: 0, y: 0, z: 0 }, health: 100, isDead: false };
      e.pos = { ...u.position };
      e.vel = { ...u.velocity };
      e.health = u.health;
      e.isDead = u.isDead;
      this.roster.set(u.playerId, e);
    }
  }

  onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'gameState': {
        this.tel.gameStates++;
        this.joined = true;
        this.wireIds.clear();
        if (m.wireIds) for (const [id, pid] of Object.entries(m.wireIds)) this.wireIds.set(Number(id), pid);
        this.pendingRoom = false;
        // Per-room seq spaces restart at 1 — the bug class this whole
        // harness exists to catch lived in forgetting this.
        this.lastHitSeq = 0;
        this.lastTickSeq = -1;
        this.roster.clear();
        for (const p of m.players) {
          if (p.id === this.id) continue;
          this.roster.set(p.id, { pos: { ...p.position }, vel: { ...p.velocity }, health: p.health, isDead: p.isDead, team: p.team, cls: p.armorClass });
        }
        if (m.localPlayerState) {
          this.self.pos = { ...m.localPlayerState.position };
          this.self.health = m.localPlayerState.health;
          this.self.isDead = m.localPlayerState.isDead;
        }
        this.deployables.clear();
        for (const d of m.deployables ?? []) this.deployables.set(d.id, { owner: d.owner, kind: d.kind, pos: { ...d.pos }, hp: d.hp ?? 0 });
        this.flags.clear();
        for (const f of m.flags ?? []) this.flags.set(f.team, { pos: { ...f.pos }, state: f.state, carrier: f.carrier });
        this.balls.clear();
        this.crawlers.clear();
        if (!this.fieldPromise) this.fieldPromise = this.loadField(m.map?.terrain, m.map?.heightScale);
        if (m.map?.structures) this.attachStructures(m.map.structures);
        if (m.sessionToken) this.sessionToken = m.sessionToken;
        this.self.team = m.team;
        this.onGameState?.();
        break;
      }
      case 'mapUpdate': {
        if (m.structures) this.attachStructures(m.structures);
        if (m.terrain || m.heightScale) this.fieldPromise = this.loadField(m.terrain, m.heightScale);
        break;
      }
      case 'ballRoster':
        for (const b of m.balls) this.balls.set(b.id, { pos: { ...b.position }, vel: { ...b.velocity }, health: 100, isDead: false });
        break;
      case 'ballSpawn': this.balls.set(m.id, { pos: { ...m.position }, vel: { ...m.velocity }, health: 100, isDead: false }); break;
      case 'ballSegment': { const b = this.balls.get(m.id); if (b) { b.pos = { ...m.position }; b.vel = { ...m.velocity }; } break; }
      case 'ballDie': this.balls.delete(m.id); break;
      case 'crawlRoster':
        for (const c of m.crawlers) this.crawlers.set(c.id, { pos: { ...c.position }, vel: { ...c.velocity }, health: 100, isDead: false });
        break;
      case 'crawlSpawn': this.crawlers.set(m.id, { pos: { ...m.position }, vel: { x: 0, y: 0, z: 0 }, health: 100, isDead: false }); break;
      case 'crawlEvt': { const c = this.crawlers.get(m.id); if (c) { c.pos = { ...m.position }; c.vel = { ...m.velocity }; } break; }
      case 'crawlDie': this.crawlers.delete(m.id); break;
      case 'flagUpdate':
        for (const f of m.flags) this.flags.set(f.team, { pos: { ...f.pos }, state: f.state, carrier: f.carrier });
        break;
      case 'deploySpawn':
        this.deployables.set(m.id, { owner: m.owner, kind: m.kind, pos: { ...m.pos }, hp: 0 });
        break;
      case 'deployGone': this.deployables.delete(m.id); break;
      case 'deployHp': { const d = this.deployables.get(m.id); if (d) d.hp = m.hp; break; }
      case 'playerJoined': {
        this.roster.set(m.playerId, { pos: { ...m.position }, vel: { x: 0, y: 0, z: 0 }, health: 100, isDead: false, team: m.team, cls: m.armorClass });
        break;
      }
      case 'playerLeft': this.roster.delete(m.playerId); break;
      case 'teamUpdate': {
        const e = this.roster.get(m.playerId);
        if (e) e.team = m.team;
        break;
      }
      case 'tickUpdate': this.applyTick(m.updates); break;
      case 'wireIds':
        for (const [id, pid] of Object.entries(m.add)) this.wireIds.set(Number(id), pid);
        for (const id of (m.remove ?? []) as number[]) this.wireIds.delete(id);
        break;
      case 'playerHit': {
        if (m.seq !== undefined) {
          if (m.seq <= this.lastHitSeq) { this.tel.dedupDrops++; break; }
          this.lastHitSeq = m.seq;
        }
        if (m.targetId === this.id) { this.tel.hitsTaken++; this.self.health = m.health; this.lastAttacker = { at: Date.now(), shooterId: m.shooterId }; }
        if (m.shooterId === this.id) this.tel.hitsDealt++;
        const e = this.roster.get(m.targetId);
        if (e) e.health = m.health;
        break;
      }
      case 'playerKill': {
        if (m.shooterId === this.id) this.tel.kills++;
        if (m.targetId === this.id) { this.tel.deaths++; this.self.isDead = true; this.self.health = 0; }
        const e = this.roster.get(m.targetId);
        if (e) { e.isDead = true; e.health = 0; }
        break;
      }
      case 'playerRespawn': {
        if (m.playerId === this.id) {
          this.self.isDead = false;
          this.self.health = 100;
          this.self.pos = { ...m.position };
        }
        const e = this.roster.get(m.playerId);
        if (e) { e.isDead = false; e.health = 100; e.pos = { ...m.position }; if (m.armorClass) e.cls = m.armorClass; }
        break;
      }
      case 'yourHealth': this.self.health = m.health; break;
      case 'correction': {
        this.tel.corrections++;
        this.self.pos = { ...m.position };
        this.self.vel = { ...m.velocity };
        break;
      }
      case 'shotRejected': {
        const n = (this.tel.rejects.get(m.reason) ?? 0) + 1;
        this.tel.rejects.set(m.reason, n);
        this.onShotRejected?.(m);
        break;
      }
      case 'claimDropped': this.onClaimDropped?.(m); break;
      case 'projectileCreated': {
        if (m.ownerId === this.id && m.shotId) this.projectiles.set(m.shotId, m.projectileId);
        break;
      }
      case 'projectileDestroyed': this.projectiles.delete(m.shotId ?? ''); break;
      case 'pong': this.pingMs = Date.now() - m.timestamp; break;
      // Server-issued RTT probe — echo verbatim like the browser's
      // pingReceived; the timestamp is the server's clock, not ours.
      case 'ping': this.send({ type: 'pong', timestamp: m.timestamp }); break;
    }
    void EVENT_TYPES; // doc anchor for future event taps
  }
}
