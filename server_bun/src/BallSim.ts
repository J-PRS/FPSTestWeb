/**
 * BallSim — server-authoritative bouncy-ball flight.
 *
 * Balls are the shared-PvE pilot species (docs/2026.09.27-shared-pve-creatures):
 * flight is closed-form between velocity discontinuities, so instead of a
 * position stream this emits SEGMENT events — spawn / bounce / lunge /
 * enrage / teleport / knockback / die — and every client replays the same
 * integrator (shared/ballSim.ts) against the same heightfield
 * (shared/heightfield.ts, data from heightmap.bin). A ball costs ~1 bounce
 * event per second; 40 balls ≈ 40 × ~60B/s ≈ 2.4 KB/s split across all
 * clients, versus ~30 KB/s for a naive position stream.
 *
 * Target rule (fodder profile): nearest ALIVE player, re-evaluated every
 * few seconds — a retarget is itself a segment event so replays keep
 * pulling toward the same player's live position.
 */
import { type Heightfield, hmHeight, hmFingerprint } from '../../shared/heightfield.ts';
import {
  type SimBall, type SimVec, type BallVariant, type SegmentKind,
  makeSimBall, stepBall, applySimDamage, type StructureCollider,
} from '../../shared/ballSim.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { ServerMessage, Vec3 } from './types.ts';
import { encodeBallSegment } from '../../shared/wire.ts';
import { STATUS } from '../../shared/status.ts';
import { logger } from './logger.ts';
import { type BallPopulation, DEFAULT_MAP_SPEC } from '../../shared/mapSpec.ts';

const TICK_DT = 0.05;           // 20Hz — matches GameServer tick broadcast
const RETARGET_INTERVAL = 2.0;  // seconds between nearest-player re-evals
// Resync floor: a ball in long flat flight emits NO bounce events, and
// client prediction diverges freely meanwhile — force a segment every
// ~1.2s so the worst-case replay error is bounded by ~1.2s of drift, not
// by however long the ball happens to stay airborne. 40 balls ≈ 2KB/s.
const RESYNC_INTERVAL = 1.2;
// Brain buckets — see CreatureSim: decision accumulators are phased by
// ball id so a same-tick spawn wave doesn't dump every nearest-player
// scan into one tick.
const BRAIN_BUCKETS = 8;
const _snap: SimVec = { x: 0, y: 0, z: 0 }; // scratch — stepBall's target arg

// 5% elite, otherwise weighted fodder sizes (v0 common, v1/v2 rare).
// Weights are cumulative so a map spec can override the whole table.
const DEFAULT_MIX: readonly number[] = [0.84, 0.07, 0.04, 0.05];
function rollVariant(mix: readonly number[] = DEFAULT_MIX): BallVariant {
  const total = mix[0]! + mix[1]! + mix[2]! + mix[3]!;
  let r = Math.random() * total;
  for (let i = 0; i < 4; i++) {
    r -= mix[i]!;
    if (r <= 0) return i as BallVariant;
  }
  return 0;
}

export class BallSim {
  private field: Heightfield | null = null;
  private balls = new Map<number, SimBall>();
  private nextId = 1;
  private pendingRespawns = 0;
  private retargetAcc = new Map<number, number>();
  private resyncAcc = new Map<number, number>();
  private broadcast: (msg: ServerMessage) => void;
  private broadcastBinary: (data: Uint8Array) => void;
  /** Reliable lane for segments — a lost resync stamp makes every client
   *  extrapolate a stale leg for ~1.2s (the rubberband storm). */
  private broadcastBinaryReliable: (data: Uint8Array) => void;
  private players: PlayerManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private simTime = 0; // monotonic sim clock — stamped on every event so clients measure TRUE age, not ping guesses
  private lastTickAt = 0;
  // setInterval under load fires LATE (measured +11ms avg) — stepping once
  // per fire makes sim time run ~18% behind wall clock, and every client
  // replay overshoots by that much. Accumulate real elapsed time and catch
  // up in whole 50ms cells so sim time tracks wall time.
  private tickAcc = 0;
  private static readonly TICK_CATCHUP_CAP = 0.25; // don't spiral on a 1s hiccup
  population: BallPopulation = DEFAULT_MAP_SPEC.balls;
  /** Variant spawn weights from the map spec — default mix below. */
  ballMix: readonly number[] = DEFAULT_MIX;
  /** Map-structure colliders — set from the room spec at construction;
   *  balls ricochet off walls/pillars. Empty on structureless maps. */
  colliders: readonly StructureCollider[] = [];

  constructor(players: PlayerManager, broadcast: (msg: ServerMessage) => void, broadcastBinary?: (data: Uint8Array) => void,
              broadcastBinaryReliable?: (data: Uint8Array) => void) {
    this.players = players;
    this.broadcast = broadcast;
    this.broadcastBinary = broadcastBinary ?? (() => {});
    this.broadcastBinaryReliable = broadcastBinaryReliable ?? this.broadcastBinary;
  }

  /** Load heightmap from disk and start the tick loop. */
  async start(heightmapPath: string): Promise<void> {
    // Bun.file is Bun-only; the P2P host imports this module type-only in
    // the browser, where Bun is undefined — read it via globalThis so the
    // reference doesn't break browser type-checking or bundling.
    const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
    if (!bunFile) throw new Error('BallSim requires Bun runtime');
    const buf = new Uint8Array(await bunFile(heightmapPath).arrayBuffer());
    this.attachField(BallSim.parseHeightmap(buf));
  }

  // No humans and no spectators watching → freeze the sim (cheap
  // hibernation for immortal rooms like 'default' that never dispose).
  dormant = false;

  /** Attach an already-loaded heightfield and start the tick loop — rooms
   *  share one parsed field rather than re-reading the file each. */
  attachField(field: Heightfield): void {
    this.field = field;
    // Re-attach on map rotation: clear the old loop or each swap adds
    // another interval and the sim ticks N× real time.
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_DT * 1000);
    this.lastTickAt = performance.now();
    logger.info('BallSim started', { heightmap: `${field.size}x${field.size}`, fp: hmFingerprint(field) });
  }

  static parseHeightmap(buf: Uint8Array): Heightfield {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const w = view.getUint32(0, true);
    const h = view.getUint32(4, true);
    if (w !== h || w < 2 || buf.byteLength !== 8 + w * h) {
      throw new Error(`Bad heightmap.bin: ${w}x${h}, ${buf.byteLength} bytes`);
    }
    return { size: w, data: buf.subarray(8), stride: 1 };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get ballCount(): number {
    return this.balls.size;
  }

  get simNow(): number {
    return this.simTime;
  }

  get hasField(): boolean {
    return this.field !== null;
  }

  /** Current segment state of every live ball — sent to joiners. */
  roster(): { id: number; variant: number; colorIdx: number; position: SimVec; velocity: SimVec; enraged: boolean; targetId: string | null; t: number }[] {
    const out = [];
    for (const b of this.balls.values()) {
      if (b.dead) continue;
      out.push({
        id: b.id, variant: b.variant, colorIdx: b.colorIdx,
        position: { x: b.x, y: b.y, z: b.z },
        velocity: { x: b.vx, y: b.vy, z: b.vz },
        enraged: b.enraged, targetId: b.targetId, tp: this.targetSnap(b),
        t: this.simTime,
      });
    }
    return out;
  }

  private alivePlayers(): { id: string; pos: SimVec }[] {
    const out: { id: string; pos: SimVec }[] = [];
    for (const [id, p] of this.players.getAllPlayers()) {
      if (!p.isDead && !(p.status & STATUS.CLOAK)) out.push({ id, pos: p.position });
    }
    return out;
  }

  private nearestPlayer(b: SimBall, alive: { id: string; pos: SimVec }[]): { id: string; pos: SimVec } | null {
    let best: { id: string; pos: SimVec } | null = null;
    let bestD = Infinity;
    for (const p of alive) {
      const dx = p.pos.x - b.x;
      const dz = p.pos.z - b.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  private spawnBall(variant: BallVariant, near?: SimVec, posOverride?: SimVec): SimBall {
    const field = this.field!;
    let x: number, z: number;
    if (posOverride) {
      x = posOverride.x; z = posOverride.z;
    } else {
      const cx = near ? near.x : 0;
      const cz = near ? near.z : 0;
      const ang = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 60;
      x = cx + Math.cos(ang) * dist;
      z = cz + Math.sin(ang) * dist;
    }
    const y = posOverride ? posOverride.y : hmHeight(field, x, z) + 40 + Math.random() * 40;
    const ang = Math.random() * Math.PI * 2;
    const spd = Math.random() * 20;
    const b = makeSimBall(
      this.nextId++, variant, Math.floor(Math.random() * 8),
      x, y, z,
      Math.cos(ang) * spd, -2, Math.sin(ang) * spd,
    );
    b.targetId = this.nearestPlayer(b, this.alivePlayers())?.id ?? null;
    this.snapTarget(b);
    this.retargetAcc.set(b.id, -RETARGET_INTERVAL * ((b.id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
    this.resyncAcc.set(b.id, -RESYNC_INTERVAL * ((b.id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
    this.balls.set(b.id, b);
    this.broadcast({
      type: 'ballSpawn', id: b.id, variant: b.variant, colorIdx: b.colorIdx,
      position: { x: b.x, y: b.y, z: b.z },
      velocity: { x: b.vx, y: b.vy, z: b.vz },
      targetId: b.targetId, tp: this.targetSnap(b),
      t: this.simTime,
    });
    return b;
  }

  /** Freeze the pull/lunge aim into the sim ball. stepBall reads the
   *  snapshot, the wire carries it — both sides integrate the same input.
   *  (If the predictor aimed at the LIVE local player pos while the server
   *  aimed at its last-received pos, arcs diverged ~100m per segment.) */
  private snapTarget(b: SimBall): void {
    const p = b.targetId ? this.players.getPlayer(b.targetId) : null;
    if (p && !p.isDead && !(p.status & STATUS.CLOAK)) {
      b.tx = p.position.x; b.ty = p.position.y; b.tz = p.position.z;
      b.tgtValid = true;
    } else {
      b.tgtValid = false;
    }
  }

  private targetSnap(b: SimBall): SimVec | null {
    return b.tgtValid ? { x: b.tx, y: b.ty, z: b.tz } : null;
  }

  private segment(b: SimBall, kind: SegmentKind): void {
    this.resyncAcc.set(b.id, 0);
    this.snapTarget(b); // segment boundary = aim refresh; clients get the same point
    // Binary — segments are the highest-rate message (~10/s per ball of
    // bounces + heartbeats); ~50B vs ~160B JSON, and no per-client
    // JSON.stringify. Reliable lane: a dropped stamp costs ~1.2s of blind
    // extrapolation — the rubberband storm seen at 100% datagram loss.
    this.broadcastBinaryReliable(encodeBallSegment({
      id: b.id, kind,
      position: { x: b.x, y: b.y, z: b.z },
      velocity: { x: b.vx, y: b.vy, z: b.vz },
      enraged: b.enraged, targetId: b.targetId, tp: this.targetSnap(b),
      // Full-sim resync: the predictors run the same integrator, so the
      // timers ride along or a client's 20s timeout / stall breaker drifts
      // off the server's (heartbeats would otherwise keep resetting them).
      et: b.enrageTimer, slowT: b.slowTimer, damp: b.dampNextBounce,
      t: this.simTime,
    }));
  }

  /** Distance to the nearest live ball — env-damage plausibility wants to
   *  know whether a melee claim has any creature near it. */
  nearestBallDist(x: number, y: number, z: number): number {
    let best = Infinity;
    for (const b of this.balls.values()) {
      if (b.dead) continue;
      const d = Math.hypot(x - b.x, y - b.y, z - b.z);
      if (d < best) best = d;
    }
    return best;
  }

  /** creatureHit claim. Lenient sanity clamps only — real validation is an
   *  anticheat-phase concern; a bogus claim costs a shoved ball, not state. */
  handleHit(playerId: string, id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    const b = this.balls.get(id);
    // A claim on a just-killed ball is the normal aim→claim race — the
    // corpse still rendered when the shot was fired. Debug, not warn.
    if (b?.dead) {
      logger.debug('creatureHit on dead ball (aim/claim race)', { playerId, id });
      return;
    }
    if (!b || !this.field) {
      // Same race as the dead-ball path above: the ball was culled (kill,
      // TTL, roster swap) between the shot and this claim — the client
      // genuinely saw it live. Warn only when there IS no field, which
      // means the claim arrived before spec terrain attached — a real bug.
      const lvl = this.field ? 'debug' : 'warn';
      logger[lvl]('creatureHit dropped: unknown ball', { playerId, id, known: this.balls.size, field: !!this.field });
      return;
    }
    const claimer = this.players.getPlayer(playerId);
    if (!claimer) {
      logger.warn('creatureHit dropped: no claimer', { playerId });
      return;
    }
    // Loose plausibility: claimer within engagement envelope of the ball
    const dx = claimer.position.x - b.x;
    const dy = claimer.position.y - b.y;
    const dz = claimer.position.z - b.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 600 * 600) {
      logger.warn('creatureHit dropped: out of range', {
        playerId, id, dist: Math.round(Math.sqrt(d2)),
        claimerPos: { x: Math.round(claimer.position.x), y: Math.round(claimer.position.y), z: Math.round(claimer.position.z) },
        ballPos: { x: Math.round(b.x), y: Math.round(b.y), z: Math.round(b.z) },
        claimerDead: claimer.isDead,
      });
      return;
    }

    const dmg = Math.max(1, Math.min(300, damage));
    let ix = 0, iy = 0, iz = 0;
    if (kx !== undefined && ky !== undefined && kz !== undefined) {
      const m = Math.hypot(kx, ky, kz);
      const cap = 60; // impulse magnitude ceiling
      if (m > 0.001) {
        const s = Math.min(cap, m) / m;
        ix = kx * s; iy = ky * s; iz = kz * s;
      }
    }
    if (applySimDamage(b, dmg, ix, iy, iz)) {
      this.kill(b, playerId);
    } else {
      this.segment(b, 'hit'); // the impulse IS a velocity discontinuity
    }
  }

  /** Kill notification for the room's scoreboard (DM creature points,
   *  team-mode nugget drops) — carries the corpse position. */
  onKilled: ((by: string, pos: Vec3, variant: number) => void) | null = null;

  private kill(b: SimBall, by?: string): void {
    b.dead = true;
    this.balls.delete(b.id);
    const pos = { x: b.x, y: b.y, z: b.z };
    this.broadcast({ type: 'ballDie', id: b.id, position: pos, by: by ?? null });
    if (by) this.onKilled?.(by, pos, b.variant);
    // Elite splitter: two child balls at the corpse
    if (b.variant === 3) {
      for (let i = 0; i < 2; i++) {
        const c = this.spawnBall(0, undefined, { x: b.x, y: b.y + 2, z: b.z });
        const a = Math.random() * Math.PI * 2;
        c.vx = Math.cos(a) * 15; c.vy = 14 + Math.random() * 6; c.vz = Math.sin(a) * 15;
        this.segment(c, 'spawn');
      }
    }
  }

  private tick(): void {
    if (!this.field || this.dormant) return;
    const now = performance.now();
    this.tickAcc += Math.min(now - this.lastTickAt, 1000) / 1000;
    this.lastTickAt = now;
    // Catch up in whole cells; cap keeps a long hiccup from exploding.
    this.tickAcc = Math.min(this.tickAcc, BallSim.TICK_CATCHUP_CAP);
    if (this.tickAcc < TICK_DT) return;

    const alive = this.alivePlayers();
    if (alive.length === 0) { this.tickAcc = 0; return; } // room empty — freeze the ecosystem

    // Population: base + per-player, spawn drip-fed one per tick fire
    const pop = this.population;
    const target = Math.min(pop.max, pop.base + Math.max(0, alive.length - 1) * pop.perPlayer);
    if (this.balls.size + this.pendingRespawns < target) {
      const near = alive[Math.floor(Math.random() * alive.length)]!.pos;
      this.spawnBall(rollVariant(this.ballMix), near);
    }

    while (this.tickAcc >= TICK_DT) {
      this.tickAcc -= TICK_DT;
      this.stepAll(alive);
    }
  }

  private stepAll(alive: { id: string; pos: SimVec }[]): void {
    this.simTime += TICK_DT;

    for (const b of this.balls.values()) {
      if (b.dead) continue;

      // Periodic retarget — committed-target rules, fodder = nearest alive.
      // Retarget broadcasts even without a velocity change: it doubles as a
      // resync heartbeat for replay drift.
      const ra = (this.retargetAcc.get(b.id) ?? 0) + TICK_DT;
      if (ra >= RETARGET_INTERVAL) {
        this.retargetAcc.set(b.id, 0);
        const t = this.nearestPlayer(b, alive);
        if ((t?.id ?? null) !== b.targetId) {
          b.targetId = t?.id ?? null;
          this.segment(b, 'bounce');
          continue;
        }
      } else {
        this.retargetAcc.set(b.id, ra);
      }

      // Pull/lunge aim comes from the snapshot last emitted on a segment —
      // predictors replay the identical input, not the live player pos.
      _snap.x = b.tx; _snap.y = b.ty; _snap.z = b.tz;
      const kind = stepBall(b, TICK_DT, this.field!, b.tgtValid ? _snap : null, true, this.colliders);
      if (kind) {
        this.segment(b, kind);
      } else {
        // No discontinuity this step — but silence itself desyncs a
        // long flight: periodic forced segment bounds client divergence.
        const rs = (this.resyncAcc.get(b.id) ?? 0) + TICK_DT;
        if (rs >= RESYNC_INTERVAL) this.segment(b, 'bounce');
        else this.resyncAcc.set(b.id, rs);
      }
    }
  }
}
