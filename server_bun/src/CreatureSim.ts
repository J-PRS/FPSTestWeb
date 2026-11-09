/**
 * CreatureSim — server-authoritative melee species (crawler pilot).
 *
 * Sister to BallSim: hop-driven creatures run the deterministic sim in
 * shared/creatureSim.ts, so the wire carries only EDGE events — spawn /
 * retarget / windup / pounce / bite / die — and every client replays the
 * identical hop stream between them (per-creature seeded LCG + committed
 * target snapshots, same trick as the balls' segment events).
 *
 * Event budget: ~1 retarget per crawler per RETARGET_INTERVAL plus one
 * edge per attack cycle — a 6-crawler room ≈ a few hundred bytes/sec.
 */
import { type Heightfield } from '../../shared/heightfield.ts';
import { botRand } from '../../shared/botRand.ts';
import {
  SPECIES_FAMILY,
  type SimBaneling,
} from '../../shared/creatureSim.ts';
import { CreatureBrain, type SimBeing, isTotem, isBaneling, isFlyer } from './creatureBrain.ts';
import {
  alivePlayers as alivePlayersOf, nearestPlayer,
  spawnCrawler as spawnCrawlerInto, snapTarget as snapTargetInto, targetSnap as targetSnapOf,
} from './creatureSpawn.ts';
import type { SimVec, StructureCollider } from '../../shared/ballSim.ts';
import { segPointDist, segPointT } from '../../shared/projSim.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { ServerMessage, Vec3, HitVerdict } from './types.ts';
import { logger } from './logger.ts';
import { ARMORNADE_OVERCAP, MAX_HIT_CLAIM_DMG, getWeaponStats, WeaponType, MELEE_ARC_DOT, MELEE_CREATURE_DAMAGE } from '../../shared/weapons.ts';
import { aoeDamage } from '../../shared/combat.ts';
import { healPool } from './healPool.ts';
import { SIM_TICK_DT } from '../../shared/wire.ts';
import { WORLD_MODEL, verbPayload, rosterRow } from '../../shared/worldModel.ts';

const TICK_DT = SIM_TICK_DT;
// Distance-tiered send: committed edges only matter to players who can
// see the crawler. Everyone still replays the same sim stream — far
// clients just ride an older committed snapshot longer, which is safe
// because the sim only diverges at decisions and retargets are the
// decisions. NEAR = full fidelity; FAR = every 4th edge (~8s cadence at
// retarget rate).
const NEAR_D2 = 80 * 80;
const FAR_SKIP = 4;
export class CreatureSim {
  // Public flat fields — creatureSpawn.ts's SpawnHost reads/writes them.
  field: Heightfield | null = null;
  /** Map yaw-OBBs — the totem beam solve and LOS gate clip against these
   *  so a compound wall blocks the lock like it blocks projectiles. */
  colliders: readonly StructureCollider[] = [];
  readonly crawlers = new Map<number, SimBeing>();
  nextId = 1;
  /** Confused hunt: the sighting the creature circles plus its expiry. */
  brain: CreatureBrain;
  broadcast: (msg: ServerMessage) => void;
  private sendTo: ((playerId: string, msg: ServerMessage) => void) | null = null;
  private edgeSeq = new Map<number, number>();
  players: PlayerManager;
  simTime = 0;
  private tickAcc = 0;
  private static readonly TICK_CATCHUP_CAP = 0.25;

  /** Max live count per melee species — map spec `creatures`. */
  pops: Record<string, number> = {};

  private aliveCount(species: string): number {
    let n = 0;
    for (const c of this.crawlers.values()) {if (!c.dead && c.species === species) {n += 1;}}
    return n;
  }

  /** Spawn/host-side randomness — tests inject a seeded fn so scenario
   *  runs are reproducible; the per-creature LCG stays the wire seed. */
  rng: () => number = (): number => botRand();
  /** Bite delivery — Room wires this to the damage funnel. */
  onBite: ((crawler: SimBeing, targetId: string) => void) | null = null;
  /** Extra gnawables — Room injects deployable candidates (`dep:N` ids)
   *  so wildlife can raze a stand like the offline kit does. */
  extraTargets: (() => { id: string; pos: SimVec }[]) | null = null;
  /** Resolve a non-player target id → live position for target commits. */
  targetPos: ((id: string) => SimVec | null) | null = null;
  /** Kamikaze pop — Room wires this to the AOE funnel. Fires whenever a
   *  baneling dies, fuse or bullet — the pop IS the attack. */
  onDetonate: ((baneling: SimBaneling) => void) | null = null;
  /** Kill feed / nugget drop hook — same shape as BallSim.onKilled. */
  onKilled: ((by: string, pos: Vec3) => void) | null = null;

  dormant = false;

  constructor(players: PlayerManager, broadcast: (msg: ServerMessage) => void, sendTo?: (playerId: string, msg: ServerMessage) => void) {
    this.players = players;
    this.broadcast = broadcast;
    this.sendTo = sendTo ?? null;
    this.brain = new CreatureBrain({
      field: (): Heightfield => this.field!,
      colliders: (): StructureCollider[] | undefined => this.colliders as StructureCollider[] | undefined,
      simTime: (): number => this.simTime,
      nearestPlayer: (c, alive): { id: string; pos: SimVec; } | null => this.nearestPlayer(c, alive),
      snapTarget: (c): void => this.snapTarget(c),
      edge: (c, kind): void => this.edge(c, kind),
      onBite: (c, pid): void | undefined => this.onBite?.(c, pid),
      kill: (c): void => this.kill(c),
      playerState: (id) => this.players.getPlayer(id) ?? null,
    });
  }

  /** The room tick drives step(); the sim owns no clock of its own. */
  attachField(field: Heightfield): void {
    this.field = field;
    logger.info('CreatureSim field attached', { fp: field.size });
  }

  stop(): void {
    // No clock to clear — the room tick owns the cadence. Kept for the
    // room-teardown call site.
    this.tickAcc = 0;
  }

  get count(): number { return this.crawlers.size; }

  get hasField(): boolean { return this.field !== null; }

  roster(): { id: number; position: Vec3; velocity: Vec3; uber: boolean; seed: number; species: string; state: string; targetId: string | null; tp: Vec3 | null; t: number; sk?: number }[] {
    const out = [];
    for (const c of this.crawlers.values()) {
      if (c.dead) {continue;}
      out.push(rosterRow(WORLD_MODEL.creature!, 'id', c.id, {
        position: { x: c.x, y: c.y, z: c.z },
        velocity: { x: c.vx, y: c.vy, z: c.vz },
        uber: c.uber, seed: c.rng, species: c.species, state: c.state,
        targetId: c.targetId, tp: this.targetSnap(c), t: this.simTime,
        // Flyer-only: orbitPhase/orbitDir steer the orbit anchor every tick
        // but never ride edges — stun pauses and missed edges offset the
        // phase permanently (replicas orbit out of sync up to 2*ORBIT_R).
        ph: isFlyer(c) ? c.orbitPhase : 0,
        od: isFlyer(c) ? c.orbitDir : 0,
        // sk rides the roster too — a client that missed retarget edges
        // re-credits the skipped quanta here or its replay clock drifts ahead.
        sk: this.skipCount.get(c.id) ?? 0,
      }));
    }
    return out as { id: number; position: Vec3; velocity: Vec3; uber: boolean; seed: number; species: string; state: string; targetId: string | null; tp: Vec3 | null; t: number; sk?: number }[];
  }

  private alivePlayers(): { id: string; pos: SimVec }[] {
    return alivePlayersOf(this, this.aliveScratch);
  }

  /** Caller-owned alive-list scratch — read only inside step(). */
  private aliveScratch: { id: string; pos: SimVec }[] = [];

  private nearestPlayer(c: SimBeing, alive: { id: string; pos: SimVec }[]): { id: string; pos: SimVec } | null {
    return nearestPlayer(c, alive);
  }

  private spawnCrawler(near: SimVec, species: string): SimBeing {
    return spawnCrawlerInto(this, near, species);
  }

  /** Freeze the pounce/chase aim into the sim — same rationale as
   *  BallSim.snapTarget: both sides steer at THIS snapshot, not the
   *  moving player. Public — creatureSpawn calls it back through the host. */
  snapTarget(c: SimBeing): void {
    snapTargetInto(this, c);
  }

  targetSnap(c: SimBeing): Vec3 | null {
    return targetSnapOf(c);
  }

  /** Cumulative retarget-skip count per creature — a retarget tick is a
   *  sim step the creature never took, so replays must subtract one
   *  quantum per skip. Absolute (since spawn), so a client that missed
   *  intermediate edges catches every skip on the next edge it sees. */
  private skipCount = new Map<number, number>();

  private edge(c: SimBeing, kind: 'retarget' | 'windup' | 'pounce' | 'bite' | 'detonate' | 'charge' | 'fire' | 'blink'): void {
    this.brain.noteEdge(c.id);
    if (kind === 'retarget') {this.skipCount.set(c.id, (this.skipCount.get(c.id) ?? 0) + 1);}
    const msg = verbPayload(WORLD_MODEL.creature!, 'update', 'id', c.id, {
      kind, sk: this.skipCount.get(c.id) ?? 0,
      // For 'blink' the position field carries the committed DESTINATION —
      // a far client that missed the decision still teleports correctly.
      position: kind === 'blink' && isTotem(c)
        ? { x: c.blinkX, y: c.blinkY, z: c.blinkZ }
        : { x: c.x, y: c.y, z: c.z },
      velocity: { x: c.vx, y: c.vy, z: c.vz },
      targetId: c.targetId, tp: this.targetSnap(c), t: this.simTime,
      // Live LCG — a dropped edge that consumed a crand draw desyncs a
      // replica's stream forever without it (roster heal is join-only).
      seed: c.rng,
    }) as ServerMessage;
    if (!this.sendTo) { this.broadcast(msg); return; }
    const n = (this.edgeSeq.get(c.id) ?? 0) + 1;
    this.edgeSeq.set(c.id, n);
    // The every-4th edge doubles as the resync: broadcast it so far
    // players AND watchers (no player record → unreachable via sendTo)
    // ride the same cadence; near players get every edge on top.
    // Retarget edges always broadcast — they carry the committed aim
    // (tp), and a far client's replica otherwise waits ~4 emits for the
    // next %4 broadcast, drifting ~8s × target speed off the aim.
    if (n % FAR_SKIP === 0 || kind === 'retarget') { this.broadcast(msg); return; }
    for (const [pid, p] of this.players.getAllPlayers()) {
      const d2 = (p.position.x - c.x) ** 2 + (p.position.z - c.z) ** 2;
      if (d2 > NEAR_D2) {continue;}
      this.sendTo(pid, msg);
    }
  }

  /** Armor-grenade plating — mirrors BallSim.armorBlast: overcap health,
   *  no edge needed since creature hp never rides the wire either. */
  armorBlast(pos: SimVec, radius: number, amount: number): void {
    const r2 = radius * radius;
    for (const c of this.crawlers.values()) {
      if (c.dead) {continue;}
      const d2 = (c.x - pos.x) ** 2 + (c.y - pos.y) ** 2 + (c.z - pos.z) ** 2;
      if (d2 > r2) {continue;}
      healPool(c, amount, c.maxHealth * ARMORNADE_OVERCAP);
    }
  }

  /** Splash into the pack — same falloff the ball swarm gets, so a disc
   *  landing among crawlers wounds the crowd instead of only the direct
   *  hit. skipId keeps a direct-hit crawler from eating blast twice. */
  splashDamage(ownerId: string, pos: SimVec, radius: number, maxDamage: number, skipId?: number): void {
    for (const c of this.crawlers.values()) {
      if (c.dead || c.id === skipId) {continue;}
      const reach = 'radius' in c ? c.radius : 1.4;
      const d = Math.max(0, Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z) - reach);
      const dmg = aoeDamage(maxDamage, d, radius);
      if (dmg >= 1) {this.handleHit(ownerId, c.id, dmg);}
    }
  }

  /** Live lookup for honest melee/contact checks — mirrors
   *  ballCombat.ballAt. */
  crawlerAt(id: number): { id: number; x: number; y: number; z: number } | null {
    const c = this.crawlers.get(id);
    return c && !c.dead ? { id: c.id, x: c.x, y: c.y, z: c.z } : null;
  }

  /** Earliest live-creature contact along a segment — mirrors
   *  ballCombat.sweepHit so real shells can whiff/hit the swarm instead
   *  of every shot being an instant claim. Ground walkers use a modest
   *  body radius; totems carry their own scale. */
  sweepHit(from: SimVec, to: SimVec, extraReach: number, backMs = 0): { id: number; t: number; d: number } | null {
    const back = backMs / 1000;
    let best: { id: number; t: number; d: number } | null = null;
    for (const c of this.crawlers.values()) {
      if (c.dead) {continue;}
      // backMs rewinds along velocity — shooter rays validate against
      // the rendered ghost, not sim-now. Linear only: species gravity
      // isn't uniform and hop arcs barely move in ~200ms.
      const center = back === 0 ? { x: c.x, y: c.y + 1, z: c.z }
        : { x: c.x - c.vx * back, y: c.y + 1 - c.vy * back, z: c.z - c.vz * back };
      const rad = 'radius' in c ? (c.radius as number) : 1.4;
      const d = segPointDist(from, to, center);
      if (d > rad + extraReach) {continue;}
      const t = segPointT(from, to, center);
      if (!best || t < best.t) {best = { id: c.id, t, d };}
    }
    return best;
  }

  /** Server-derived melee swing — same cone BallCombat.meleeSweep pays
   *  balls with; crawler claims never carried an impulse, so this is
   *  damage-only like the claim path it replaces. */
  meleeSweep(ownerId: string, pos: SimVec, dir: SimVec): void {
    const stats = getWeaponStats(WeaponType.Melee);
    const reach = stats.aoeRadius, dmg = MELEE_CREATURE_DAMAGE;
    for (const c of this.crawlers.values()) {
      if (c.dead) {continue;}
      const rad = 'radius' in c ? (c.radius as number) : 1.4;
      const dx = c.x - pos.x, dy = c.y - pos.y, dz = c.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > reach + rad || d < 1e-6) {continue;}
      if ((dx / d) * dir.x + (dy / d) * dir.y + (dz / d) * dir.z < MELEE_ARC_DOT) {continue;}
      this.handleHit(ownerId, c.id, dmg);
    }
  }

  /** Blast knockback on the pack — same flat dir*force the client predicts
   *  on net-driven creatures, pull flips it. Without it a blast visibly
   *  throws them and the next segment yanks them back. */
  knock(pos: SimVec, radius: number, force: number, pull = false): void {
    if (!Number.isFinite(pos.x + pos.y + pos.z + radius + force)) {return;}
    const s = pull ? -1 : 1;
    for (const c of this.crawlers.values()) {
      if (c.dead) {continue;}
      const rad = 'radius' in c ? (c.radius as number) : 1.4;
      const dx = c.x - pos.x, dy = c.y - pos.y, dz = c.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius + rad || d < 1e-6) {continue;}
      c.vx += (dx / d) * force * s;
      c.vy += (dy / d) * force * s;
      c.vz += (dz / d) * force * s;
    }
  }

  /** crawlerHit claim — mirrors BallSim.handleHit (lenient clamps, the
   *  real validation is anticheat-phase). Returns whether it killed. */
  handleHit(playerId: string, id: number, damage: number): HitVerdict {
    const c = this.crawlers.get(id);
    if (c?.dead) {return { killed: false, reason: 'deadball' };}
    if (!c || !this.field) {
      logger[this.field ? 'debug' : 'warn']('crawlerHit dropped: unknown id', { playerId, id });
      return { killed: false, reason: 'unknown' };
    }
    const claimer = this.players.getPlayer(playerId);
    if (!claimer) {return { killed: false, reason: 'noclaimer' };}
    const d2 = (claimer.position.x - c.x) ** 2 + (claimer.position.y - c.y) ** 2 + (claimer.position.z - c.z) ** 2;
    if (d2 > 600 * 600) {
      logger.warn('crawlerHit dropped: out of range', { playerId, id });
      return { killed: false, reason: 'range' };
    }
    const dmg = Math.max(1, Math.min(MAX_HIT_CLAIM_DMG, damage));
    const dead = SPECIES_FAMILY[c.family].damage(c, dmg);
    if (dead) {this.kill(c, playerId);}
    else {this.brain.noteHit(c.id, playerId);} // the shooter owns the grudge
    // Stagger is a timer edge — the next hop decision diverges only if a
    // predictor skips it, and the resync heartbeat bounds that drift.
    return { killed: dead };
  }

  private kill(c: SimBeing, by?: string): void {
    c.dead = true;
    this.crawlers.delete(c.id);
    // Same key domain — the per-crawler state-sequence map would keep
    // one dead entry per kill forever.
    this.edgeSeq.delete(c.id);
    this.skipCount.delete(c.id);
    this.brain.forget(c.id);
    // A baneling dies by popping — shot or fuse, the blast is the point.
    if (isBaneling(c)) { this.edge(c, 'detonate'); this.onDetonate?.(c); }
    const pos = { x: c.x, y: c.y, z: c.z };
    this.broadcast(verbPayload(WORLD_MODEL.creature!, 'gone', 'id', c.id, { position: pos, by }) as ServerMessage);
    if (by) {this.onKilled?.(by, pos);}
  }

  /** Gate-adoption cull: every crawler leaves with a 'gone' edge — a bare
   *  crawlers.clear() orphans every replica (wire creatures have no TTL).
   *  Banelings do NOT detonate: a cull is a removal, not a kill. */
  cullAll(): void {
    for (const c of this.crawlers.values()) {
      c.dead = true;
      this.crawlers.delete(c.id);
      this.edgeSeq.delete(c.id);
      this.skipCount.delete(c.id);
      this.brain.forget(c.id);
      this.broadcast(verbPayload(WORLD_MODEL.creature!, 'gone', 'id', c.id, { position: { x: c.x, y: c.y, z: c.z } }) as ServerMessage);
    }
  }

  /** Step by real elapsed dt — the room tick calls this once per fire;
   *  tests and embedded hosts drive it directly (sim-time ≠ wall). */
  step(dt: number): void {
    if (!this.field || this.dormant) {return;}
    this.tickAcc += dt;
    this.tickAcc = Math.min(this.tickAcc, CreatureSim.TICK_CATCHUP_CAP);
    if (this.tickAcc < TICK_DT) {return;}
    const alive = this.alivePlayers();
    if (alive.length === 0 && !this.anyTargeted()) { this.tickAcc = 0; return; }
    for (const [species, cap] of Object.entries(this.pops)) {
      if (cap > 0 && this.aliveCount(species) < cap && alive.length > 0) {
        const near = alive[Math.floor(this.rng() * alive.length)]!.pos;
        this.spawnCrawler(near, species);
      }
    }
    while (this.tickAcc >= TICK_DT) {
      this.tickAcc -= TICK_DT;
      this.simTime += TICK_DT;
      this.brain.stepAll(this.crawlers.values(), alive);
    }
  }

  /** Any creature still holding a committed target — a fully-cloaked room
   *  reports zero alive players but ghost-hunters must keep stepping. */
  private anyTargeted(): boolean {
    for (const c of this.crawlers.values()) {if (!c.dead && c.tgtValid) {return true;}}
    return false;
  }

}
