// Headless game client — connects to a running server over a REAL
// WebSocket, speaks the real shared/protocol + wire codec, and keeps the
// same client-side bookkeeping the browser client does (roster, per-room
// seq watermarks, claim→projectile binding). The behavior layer lives in
// bot.ts; this file is transport + state.

import type { ClientMessage, ServerMessage, TickUpdatePlayer, Vec3 } from '../../shared/protocol.ts';
import { decodeTickFrame, isWireFrame } from '../../shared/wire.ts';
import { LatencyLink } from './latency.ts';

export interface RemoteEntry {
  pos: Vec3;
  vel: Vec3;
  health: number;
  isDead: boolean;
  team?: string;
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
  hops: number;
  dedupDrops: number;
}

const EVENT_TYPES = new Set(['playerHit', 'playerKill', 'playerRespawn', 'shotRejected', 'correction', 'yourHealth']);

export class NetClient {
  readonly id: string;
  ws: WebSocket | null = null;
  link: LatencyLink;
  tel: NetTelemetry = {
    hitsDealt: 0, hitsTaken: 0, kills: 0, deaths: 0,
    shots: 0, claims: 0, rejects: new Map(), corrections: 0,
    gameStates: 0, hops: 0, dedupDrops: 0,
  };

  /** Self state — pos driven by bot locomotion (position channel), the
   *  rest adopted from server events exactly like the browser client. */
  self = { pos: { x: 0, y: 60, z: 0 } as Vec3, vel: { x: 0, y: 0, z: 0 } as Vec3, health: 100, isDead: false, team: undefined as string | undefined };
  roster = new Map<string, RemoteEntry>();
  /** shotId → server projectile id, learned from projectileCreated echoes. */
  projectiles = new Map<string, string>();
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
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private joinTimer: ReturnType<typeof setInterval> | null = null;
  pingMs = 0;
  closed = false;
  closeInfo = '';

  constructor(private url: string, id: string, link?: LatencyLink, private joinOpts: { room?: string; mode?: string } = {}) {
    this.id = id;
    this.link = link ?? new LatencyLink({ pingMs: 0, jitterMs: 0, lossRate: 0 });
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.joined = false;
      this.closed = false;
      this.closeInfo = '';
      ws.onopen = () => {
        // Join retries until the first gameState lands — a swallowed or
        // throttled join would otherwise leave the bot a silent ghost,
        // the same failure a real client's retry button papers over.
        const joinMsg = JSON.stringify({ type: 'join', playerId: this.id, transport: 'ws', token: this.sessionToken, room: this.joinOpts.room, mode: this.joinOpts.mode });
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
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') this.onMessage(JSON.parse(ev.data) as ServerMessage);
        else this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = (ev) => { this.closed = true; this.closeInfo = `${ev.code} ${ev.reason}`; };
      ws.onerror = () => reject(new Error(`netbot ${this.id} ws error`));
    });
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

  private onBinary(u8: Uint8Array): void {
    if (!isWireFrame(u8)) return;
    const tick = decodeTickFrame(u8);
    if (!tick) return;
    if (tick.tickSeq <= this.lastTickSeq) return; // stale frame, same rule as the client
    this.lastTickSeq = tick.tickSeq;
    this.applyTick(tick.updates);
  }

  private applyTick(updates: TickUpdatePlayer[]): void {
    for (const u of updates) {
      if (u.playerId === this.id) continue;
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
        this.pendingRoom = false;
        // Per-room seq spaces restart at 1 — the bug class this whole
        // harness exists to catch lived in forgetting this.
        this.lastHitSeq = 0;
        this.lastTickSeq = -1;
        this.roster.clear();
        for (const p of m.players) {
          if (p.id === this.id) continue;
          this.roster.set(p.id, { pos: { ...p.position }, vel: { ...p.velocity }, health: p.health, isDead: p.isDead, team: p.team });
        }
        if (m.localPlayerState) {
          this.self.pos = { ...m.localPlayerState.position };
          this.self.health = m.localPlayerState.health;
          this.self.isDead = m.localPlayerState.isDead;
        }
        if (m.sessionToken) this.sessionToken = m.sessionToken;
        this.self.team = m.team;
        break;
      }
      case 'playerJoined': {
        this.roster.set(m.playerId, { pos: { ...m.position }, vel: { x: 0, y: 0, z: 0 }, health: 100, isDead: false, team: m.team });
        break;
      }
      case 'playerLeft': this.roster.delete(m.playerId); break;
      case 'teamUpdate': {
        const e = this.roster.get(m.playerId);
        if (e) e.team = m.team;
        break;
      }
      case 'tickUpdate': this.applyTick(m.updates); break;
      case 'playerHit': {
        if (m.seq !== undefined) {
          if (m.seq <= this.lastHitSeq) { this.tel.dedupDrops++; break; }
          this.lastHitSeq = m.seq;
        }
        if (m.targetId === this.id) { this.tel.hitsTaken++; this.self.health = m.health; }
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
        if (e) { e.isDead = false; e.health = 100; e.pos = { ...m.position }; }
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
        break;
      }
      case 'projectileCreated': {
        if (m.ownerId === this.id && m.shotId) this.projectiles.set(m.shotId, m.projectileId);
        break;
      }
      case 'projectileDestroyed': this.projectiles.delete(m.shotId ?? ''); break;
      case 'pong': this.pingMs = Date.now() - m.timestamp; break;
    }
    void EVENT_TYPES; // doc anchor for future event taps
  }
}
