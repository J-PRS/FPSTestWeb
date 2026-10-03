/**
 * BallSim — server-authoritative bouncy-ball flight.
 *
 * Balls are the shared-PvE pilot species (docs/2026.09.27-shared-pve-creatures):
 * flight is closed-form between velocity discontinuities, so instead of a
 * position stream this emits SEGMENT events — spawn / bounce / lunge /
 * enrage / teleport / knockback / die — and every client replays the same
 * integrator (shared/ballSim.ts) against the same heightfield
 * (shared/heightfield.ts, data from heightmap.bin). A ball costs ~1 bounce
 *
 * Terminology: "balls" (this sim, `b:` target ids, `creatureHit` claims —
 * the claim name is a historical leftover) are their own entity kind,
 * not creatures; "creatures" (CreatureSim, `crawlerHit` claims) are the
 * species pops (crawler/scarab/rakk/...). Both funnel kills into
 * scoring.nonPlayerKill.
 * event per second; 40 balls ≈ 40 × ~60B/s ≈ 2.4 KB/s split across all
 * clients, versus ~30 KB/s for a naive position stream.
 *
 * Target rule (fodder profile): nearest ALIVE player, re-evaluated every
 * few seconds — a retarget is itself a segment event so replays keep
 * pulling toward the same player's live position.
 */
import { type Heightfield, hmFingerprint, hmParseBin } from '../../shared/heightfield.ts';
import {
  type SimBall, type SimVec, type BallVariant, type SegmentKind,
  stepBall, type StructureCollider,
} from '../../shared/ballSim.ts';
import { ColliderIndex } from '../../shared/solidWorld.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { ServerMessage, Vec3, HitVerdict } from './types.ts';
import { encodeBallSegment } from '../../shared/wire.ts';
import { logger } from './logger.ts';
import { type BallPopulation, DEFAULT_MAP_SPEC } from '../../shared/mapSpec.ts';
import { BallCombat } from './ballCombat.ts';
import {
  DEFAULT_MIX, rollVariant, alivePlayers, nearestPlayer,
  spawnBall as spawnBallInto, snapTarget as snapTargetInto, targetSnap as targetSnapOf,
  RETARGET_INTERVAL, RESYNC_INTERVAL,
} from './ballSpawn.ts';

const TICK_DT = 0.05;           // 20Hz — matches GameServer tick broadcast
// Resync floor: a ball in long flat flight emits NO bounce events, and
// client prediction diverges freely meanwhile — force a segment every
// ~1.2s so the worst-case replay error is bounded by ~1.2s of drift, not
// by however long the ball happens to stay airborne. 40 balls ≈ 2KB/s.
const _snap: SimVec = { x: 0, y: 0, z: 0 }; // scratch — stepBall's target arg

export class BallSim {
  // Public flat fields — ballSpawn.ts's SpawnHost reads/writes them.
  field: Heightfield | null = null;
  readonly balls = new Map<number, SimBall>();
  nextId = 1;
  private pendingRespawns = 0;
  readonly retargetAcc = new Map<number, number>();
  readonly resyncAcc = new Map<number, number>();
  broadcast: (msg: ServerMessage) => void;

  /** Reliable lane for segments — a lost resync stamp makes every client
   *  extrapolate a stale leg for ~1.2s (the rubberband storm). */
  private broadcastBinaryReliable: (data: Uint8Array) => void;
  players: PlayerManager; // public — ballSpawn target checks read the roster
  simTime = 0; // monotonic sim clock — stamped on every event so clients measure TRUE age, not ping guesses
  // The room tick feeds real elapsed dt; whole-cell catch-up keeps sim
  // time tracking wall time even when a tick arrives early or late.
  private tickAcc = 0;
  private combat: BallCombat;
  private static readonly TICK_CATCHUP_CAP = 0.25; // don't spiral on a 1s hiccup
  population: BallPopulation = DEFAULT_MAP_SPEC.balls;
  /** Variant spawn weights from the map spec — default mix below. */
  ballMix: readonly number[] = DEFAULT_MIX;
  /** Map-structure colliders — set from the room spec at construction;
   *  balls ricochet off walls/pillars. Empty on structureless maps. */
  private _colliders: readonly StructureCollider[] = [];
  colliderIndex: ColliderIndex | null = null;
  get colliders(): readonly StructureCollider[] { return this._colliders; }
  set colliders(list: readonly StructureCollider[]) {
    this._colliders = list;
    this.colliderIndex = list.length ? new ColliderIndex(list) : null;
  }

  constructor(players: PlayerManager, broadcast: (msg: ServerMessage) => void,
              broadcastBinaryReliable?: (data: Uint8Array) => void) {
    this.players = players;
    this.broadcast = broadcast;
    this.broadcastBinaryReliable = broadcastBinaryReliable ?? (() => {});
    this.combat = new BallCombat({
      balls: () => this.balls,
      field: () => this.field,
      players,
      segment: (b, kind) => this.segment(b, kind),
      kill: (b, by) => this.kill(b, by),
    });
  }

  /** Load heightmap from disk — standalone hosts (demos) without a Room. */
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
  /** Spawn/host-side randomness — tests inject a seeded fn so scenario
   *  runs are reproducible; the wire only carries resolved outcomes. */
  rng: () => number = Math.random;

  /** Attach an already-loaded heightfield — rooms share one parsed field
   *  rather than re-reading the file each. The room tick drives step();
   *  the sim owns no clock of its own. */
  attachField(field: Heightfield): void {
    this.field = field;
    logger.info('BallSim field attached', { heightmap: `${field.size}x${field.size}`, fp: hmFingerprint(field) });
  }

  static parseHeightmap(buf: Uint8Array): Heightfield {
    return hmParseBin(buf);
  }

  stop(): void {
    // No clock to clear — the room tick owns the cadence. Kept for the
    // room-teardown call site.
    this.tickAcc = 0;
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

  private spawnBall(variant: BallVariant, near?: SimVec, posOverride?: SimVec): SimBall {
    return spawnBallInto(this, variant, near, posOverride);
  }

  snapTarget(b: SimBall): void { // public — ballSpawn host interface
    snapTargetInto(this.players, b);
  }

  targetSnap(b: SimBall): SimVec | null { // public — ballSpawn host interface
    return targetSnapOf(b);
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
      // sim clock rides along or a client's 20s timeout / stall breaker drifts
      // off the server's (heartbeats would otherwise keep resetting them).
      et: b.enrageTimer, slowT: b.slowTimer, damp: b.dampNextBounce,
      t: this.simTime,
    }));
  }

  /** Distance to the nearest live ball — env-damage plausibility wants to
   *  know whether a melee claim has any creature near it. */
  nearestBallDist(x: number, y: number, z: number): number {
    return this.combat.nearestBallDist(x, y, z);
  }

  /** Live ball lookup for honest melee/contact checks. */
  ballAt(id: number): { x: number; y: number; z: number; radius: number } | null {
    return this.combat.ballAt(id);
  }

  /** Armor plating sweep — BallCombat owns the damage surface. */
  armorBlast(pos: SimVec, radius: number, amount: number): void {
    this.combat.armorBlast(pos, radius, amount);
  }

  sweepHit(from: SimVec, to: SimVec, extraReach: number): { id: number; t: number; d: number } | null {
    return this.combat.sweepHit(from, to, extraReach);
  }

  splashDamage(ownerId: string, pos: SimVec, radius: number, maxDamage: number, skipId?: number): void {
    this.combat.splashDamage(ownerId, pos, radius, maxDamage, skipId);
  }

  /** creatureHit claim — BallCombat does the lenient clamps + impulse cap. */
  handleHit(playerId: string, id: number, damage: number, kx?: number, ky?: number, kz?: number): HitVerdict {
    return this.combat.handleHit(playerId, id, damage, kx, ky, kz);
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
        const a = this.rng() * Math.PI * 2;
        c.vx = Math.cos(a) * 15; c.vy = 14 + this.rng() * 6; c.vz = Math.sin(a) * 15;
        this.segment(c, 'spawn');
      }
    }
  }

  /** Step by real elapsed dt — the room tick calls this once per fire;
   *  scenario tests and warp soaks drive it directly (sim-time ≠ wall). */
  step(dt: number): void {
    if (!this.field || this.dormant) return;
    this.tickAcc += dt;
    // Catch up in whole cells; cap keeps a long hiccup from exploding.
    this.tickAcc = Math.min(this.tickAcc, BallSim.TICK_CATCHUP_CAP);
    if (this.tickAcc < TICK_DT) return;

    const alive = alivePlayers(this.players);
    if (alive.length === 0) { this.tickAcc = 0; return; } // room empty — freeze the ecosystem

    // Population: base + per-player, spawn drip-fed one per tick fire
    const pop = this.population;
    const target = Math.min(pop.max, pop.base + Math.max(0, alive.length - 1) * pop.perPlayer);
    if (this.balls.size + this.pendingRespawns < target) {
      const near = alive[Math.floor(this.rng() * alive.length)]!.pos;
      this.spawnBall(rollVariant(this.ballMix, this.rng), near);
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
        const t = nearestPlayer(b, alive);
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
      const kind = stepBall(b, TICK_DT, this.field!, b.tgtValid ? _snap : null, true, { colliders: this.colliders, colliderIndex: this.colliderIndex ?? undefined, rand: this.rng });
      if (kind) {
        this.segment(b, kind);
      } else {
        // No discontinuity this step — but silence itself desyncs a
        // long flight: periodic forced segment bounds client divergence.
        // Kind 'segment' labels the heartbeat — the client's rubberband
        // probe only treats fresh-anchor prediction-vs-truth as desync
        // signal; labeling it 'bounce' drowned every resync in edge noise.
        const rs = (this.resyncAcc.get(b.id) ?? 0) + TICK_DT;
        if (rs >= RESYNC_INTERVAL) this.segment(b, 'segment');
        else this.resyncAcc.set(b.id, rs);
      }
    }
  }
}
