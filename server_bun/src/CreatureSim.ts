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
import { type Heightfield, hmHeight } from '../../shared/heightfield.ts';
import {
  type SimCrawler, type SimFlyer, type SimRoller, type SimSlither, type SimBaneling, type SimTotem, type CrawlerEvent,
  makeSimCrawler, stepCrawler, applyCrawlerDamage, commitTarget,
  isFlyerSpecies, makeSimFlyer, stepFlyer, applyFlyerDamage,
  isRollerSpecies, makeSimRoller, stepRoller, applyRollerDamage,
  isSlitherSpecies, makeSimSlither, stepSlither, applySlitherDamage,
  isBanelingSpecies, makeSimBaneling, stepBaneling, applyBanelingDamage,
  isTotemSpecies, makeSimTotem, stepTotem, applyTotemDamage, totemFireTargets,
  CRAWLER_SIM,
} from '../../shared/creatureSim.ts';
import type { SimVec, StructureCollider } from '../../shared/ballSim.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { ServerMessage, Vec3 } from './types.ts';
import { STATUS } from '../../shared/status.ts';
import { logger } from './logger.ts';
import { ARMORNADE_OVERCAP, MAX_HIT_CLAIM_DMG } from '../../shared/weapons.ts';

const TICK_DT = 0.05;
const RETARGET_INTERVAL = CRAWLER_SIM.RETARGET_S;
// Silence desyncs a wanderer just like a long-flying ball — force a
// resync edge (same committed snapshot) every few seconds.
const RESYNC_INTERVAL = 4.0;
const _snap: SimVec = { x: 0, y: 0, z: 0 };
// Distance-tiered send: committed edges only matter to players who can
// see the crawler. Everyone still replays the same sim stream — far
// clients just ride an older committed snapshot longer, which is safe
// because the sim only diverges at decisions and retargets are the
// decisions. NEAR = full fidelity; FAR = every 4th edge (~8s cadence at
// retarget rate).
const NEAR_D2 = 80 * 80;
const FAR_SKIP = 4;
// Cloak confusion: seconds a creature keeps hunting its prey's last
// sighting, and the radius the ghost target wanders.
const CONFUSE_TTL = 7;
const CONFUSE_DRIFT_R = 6;
// Brain buckets: retarget/resync decision ticks are staggered across
// BRAIN_BUCKETS phases keyed by creature id, so a pack that all spawned
// on the same tick doesn't dump its O(players) scans + edge fanouts into
// one frame. Classic amortized-AI trick — physics still steps every tick
// (dt can't change without diverging predictors), only decisions
// spread. Re-seeded on spawn so same-tick batches land in different
// buckets.
const BRAIN_BUCKETS = 8;

/** Hop + flyer + roller + totem families share every wire field — the
 *  union only matters at step/damage dispatch, discriminated by
 *  family-only fields (`orbitPhase` = flyer, `hitCd` = roller). */
type SimBeing = SimCrawler | SimFlyer | SimRoller | SimSlither | SimBaneling | SimTotem;
const isFlyer = (c: SimBeing): c is SimFlyer => 'orbitPhase' in c;
const isRoller = (c: SimBeing): c is SimRoller => 'hitCd' in c;
const isSlither = (c: SimBeing): c is SimSlither => 'animT' in c;
const isBaneling = (c: SimBeing): c is SimBaneling => 'age' in c;
const isTotem = (c: SimBeing): c is SimTotem => 'lockDist' in c;

export class CreatureSim {
  private field: Heightfield | null = null;
  /** Map yaw-OBBs — the totem beam solve and LOS gate clip against these
   *  so a compound wall blocks the lock like it blocks projectiles. */
  colliders: readonly StructureCollider[] = [];
  private crawlers = new Map<number, SimBeing>();
  private nextId = 1;
  private retargetAcc = new Map<number, number>();
  /** Confused hunt: the sighting the creature circles plus its expiry. */
  private confuseGhosts = new Map<number, { x: number; y: number; z: number; until: number }>();
  private resyncAcc = new Map<number, number>();
  private broadcast: (msg: ServerMessage) => void;
  private sendTo: ((playerId: string, msg: ServerMessage) => void) | null = null;
  private edgeSeq = new Map<number, number>();
  private players: PlayerManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private simTime = 0;
  private lastTickAt = 0;
  private tickAcc = 0;
  private static readonly TICK_CATCHUP_CAP = 0.25;

  /** Max live count per melee species — map spec `creatures`. */
  pops: Record<string, number> = {};

  private aliveCount(species: string): number {
    let n = 0;
    for (const c of this.crawlers.values()) if (!c.dead && c.species === species) n++;
    return n;
  }

  /** Spawn/host-side randomness — tests inject a seeded fn so scenario
   *  runs are reproducible; the per-creature LCG stays the wire seed. */
  rng: () => number = Math.random;
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
  }

  attachField(field: Heightfield): void {
    this.field = field;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_DT * 1000);
    this.lastTickAt = performance.now();
    logger.info('CreatureSim started', { fp: field.size });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get count(): number { return this.crawlers.size; }

  roster(): { id: number; position: Vec3; velocity: Vec3; uber: boolean; seed: number; species: string; state: string; targetId: string | null; tp: Vec3 | null; t: number }[] {
    const out = [];
    for (const c of this.crawlers.values()) {
      if (c.dead) continue;
      out.push({
        id: c.id,
        position: { x: c.x, y: c.y, z: c.z },
        velocity: { x: c.vx, y: c.vy, z: c.vz },
        uber: c.uber, seed: c.rng, species: c.species, state: c.state,
        targetId: c.targetId, tp: this.targetSnap(c), t: this.simTime,
      });
    }
    return out;
  }

  private alivePlayers(): { id: string; pos: SimVec }[] {
    const out: { id: string; pos: SimVec }[] = [];
    for (const [id, p] of this.players.getAllPlayers()) {
      if (!p.isDead && !(p.status & STATUS.CLOAK)) out.push({ id, pos: p.position });
    }
    if (this.extraTargets) out.push(...this.extraTargets());
    return out;
  }

  private nearestPlayer(c: SimBeing, alive: { id: string; pos: SimVec }[]): { id: string; pos: SimVec } | null {
    let best: { id: string; pos: SimVec } | null = null;
    let bestD = Infinity;
    for (const p of alive) {
      const d = (p.pos.x - c.x) ** 2 + (p.pos.z - c.z) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  private spawnCrawler(near: SimVec, species: string): SimBeing {
    const field = this.field!;
    const ang = this.rng() * Math.PI * 2;
    const dist = 40 + this.rng() * 50;
    const x = near.x + Math.cos(ang) * dist;
    const z = near.z + Math.sin(ang) * dist;
    const seed = (this.rng() * 0xffffffff) >>> 0 || 1;
    const gy = hmHeight(field, x, z);
    const id = this.nextId++;
    const uber = this.rng() < 0.05;
    const c: SimBeing = isFlyerSpecies(species)
      ? makeSimFlyer(id, { x, y: gy, z }, uber, seed, species)
      : isTotemSpecies(species)
        ? makeSimTotem(id, { x, y: gy, z }, uber, seed, species)
        : isRollerSpecies(species)
          ? makeSimRoller(id, { x, y: gy, z }, uber, seed, species)
          : isSlitherSpecies(species)
            ? makeSimSlither(id, { x, y: gy, z }, uber, seed, species)
            : isBanelingSpecies(species)
              ? makeSimBaneling(id, { x, y: gy, z }, uber, seed, species)
              : makeSimCrawler(id, { x, y: gy, z }, uber, seed, species);
    if (isFlyer(c)) c.y = gy + c.sp.ORBIT_ALT; // flyers enter at cruise alt
    if (isRoller(c)) c.y = gy + 1.6;           // rollers ride the surface
    if (isSlither(c)) c.y = gy + 0.5;          // belly on the dirt
    if (isBaneling(c)) c.y = gy + 0.7;         // sac skims low
    // Negative offset pushes this crawler's first retarget into its own
    // bucket instead of the spawn tick — the spread survives every reset.
    this.retargetAcc.set(c.id, -RETARGET_INTERVAL * ((c.id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
    this.resyncAcc.set(c.id, -RESYNC_INTERVAL * ((c.id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
    c.targetId = this.nearestPlayer(c, this.alivePlayers())?.id ?? null;
    this.snapTarget(c);
    this.crawlers.set(c.id, c);
    this.broadcast({
      type: 'crawlSpawn', id: c.id, position: { x: c.x, y: c.y, z: c.z },
      seed, uber: c.uber, species: c.species,
      targetId: c.targetId, tp: this.targetSnap(c),
      t: this.simTime,
    });
    return c;
  }

  /** Freeze the pounce/chase aim into the sim — same rationale as
   *  BallSim.snapTarget: both sides steer at THIS snapshot, not the
   *  moving player. */
  private snapTarget(c: SimBeing): void {
    const p = c.targetId ? this.players.getPlayer(c.targetId) : null;
    if (p && !p.isDead && !(p.status & STATUS.CLOAK)) {
      commitTarget(c, c.targetId, p.position);
    } else if (c.targetId && this.targetPos) {
      const tp = this.targetPos(c.targetId);
      if (tp) { commitTarget(c, c.targetId, tp); return; }
      commitTarget(c, null, null);
    } else {
      commitTarget(c, null, null);
    }
  }

  private targetSnap(c: SimBeing): Vec3 | null {
    return c.tgtValid ? { x: c.tx, y: c.ty, z: c.tz } : null;
  }

  private edge(c: SimBeing, kind: 'retarget' | 'windup' | 'pounce' | 'bite' | 'detonate' | 'charge' | 'fire' | 'blink'): void {
    this.resyncAcc.set(c.id, 0);
    const msg: ServerMessage = {
      type: 'crawlEvt', id: c.id, kind,
      // For 'blink' the position field carries the committed DESTINATION —
      // a far client that missed the decision still teleports correctly.
      position: kind === 'blink' && isTotem(c)
        ? { x: c.blinkX, y: c.blinkY, z: c.blinkZ }
        : { x: c.x, y: c.y, z: c.z },
      velocity: { x: c.vx, y: c.vy, z: c.vz },
      targetId: c.targetId, tp: this.targetSnap(c), t: this.simTime,
    };
    if (!this.sendTo) { this.broadcast(msg); return; }
    const n = (this.edgeSeq.get(c.id) ?? 0) + 1;
    this.edgeSeq.set(c.id, n);
    // The every-4th edge doubles as the resync: broadcast it so far
    // players AND watchers (no player record → unreachable via sendTo)
    // ride the same cadence; near players get every edge on top.
    if (n % FAR_SKIP === 0) { this.broadcast(msg); return; }
    for (const [pid, p] of this.players.getAllPlayers()) {
      const d2 = (p.position.x - c.x) ** 2 + (p.position.z - c.z) ** 2;
      if (d2 > NEAR_D2) continue;
      this.sendTo(pid, msg);
    }
  }

  /** Armor-grenade plating — mirrors BallSim.armorBlast: overcap health,
   *  no edge needed since creature hp never rides the wire either. */
  armorBlast(pos: SimVec, radius: number, amount: number): void {
    const r2 = radius * radius;
    for (const c of this.crawlers.values()) {
      if (c.dead) continue;
      const d2 = (c.x - pos.x) ** 2 + (c.y - pos.y) ** 2 + (c.z - pos.z) ** 2;
      if (d2 > r2) continue;
      c.health = Math.min(c.maxHealth * ARMORNADE_OVERCAP, c.health + amount);
    }
  }

  /** crawlerHit claim — mirrors BallSim.handleHit (lenient clamps, the
   *  real validation is anticheat-phase). */
  handleHit(playerId: string, id: number, damage: number): void {
    const c = this.crawlers.get(id);
    if (c?.dead) return;
    if (!c || !this.field) {
      logger[this.field ? 'debug' : 'warn']('crawlerHit dropped: unknown id', { playerId, id });
      return;
    }
    const claimer = this.players.getPlayer(playerId);
    if (!claimer) return;
    const d2 = (claimer.position.x - c.x) ** 2 + (claimer.position.y - c.y) ** 2 + (claimer.position.z - c.z) ** 2;
    if (d2 > 600 * 600) {
      logger.warn('crawlerHit dropped: out of range', { playerId, id });
      return;
    }
    const dmg = Math.max(1, Math.min(MAX_HIT_CLAIM_DMG, damage));
    const dead = isFlyer(c)
      ? applyFlyerDamage(c, dmg)
      : isTotem(c)
        ? applyTotemDamage(c, dmg)
        : isRoller(c)
          ? applyRollerDamage(c, dmg)
          : isSlither(c)
            ? applySlitherDamage(c, dmg)
            : isBaneling(c)
              ? applyBanelingDamage(c, dmg)
              : applyCrawlerDamage(c, dmg);
    if (dead) this.kill(c, playerId);
    // Stagger is a timer edge — the next hop decision diverges only if a
    // predictor skips it, and the resync heartbeat bounds that drift.
  }

  private kill(c: SimBeing, by?: string): void {
    c.dead = true;
    this.crawlers.delete(c.id);
    this.confuseGhosts.delete(c.id);
    // A baneling dies by popping — shot or fuse, the blast is the point.
    if (isBaneling(c)) { this.edge(c, 'detonate'); this.onDetonate?.(c); }
    const pos = { x: c.x, y: c.y, z: c.z };
    this.broadcast({ type: 'crawlDie', id: c.id, position: pos, by: by ?? null });
    if (by) this.onKilled?.(by, pos);
  }

  /** Drive the sim manually — tests and embedded hosts step it
   *  deterministically instead of waiting on the wall-clock interval. */
  step(dt: number): void {
    if (!this.field || this.dormant) return;
    this.tickAcc += dt;
    this.tickAcc = Math.min(this.tickAcc, CreatureSim.TICK_CATCHUP_CAP);
    if (this.tickAcc < TICK_DT) return;
    const alive = this.alivePlayers();
    if (alive.length === 0 && !this.anyTargeted()) { this.tickAcc = 0; return; }
    for (const [species, cap] of Object.entries(this.pops)) {
      if (cap > 0 && this.aliveCount(species) < cap && alive.length) {
        const near = alive[Math.floor(this.rng() * alive.length)]!.pos;
        this.spawnCrawler(near, species);
      }
    }
    while (this.tickAcc >= TICK_DT) {
      this.tickAcc -= TICK_DT;
      this.stepAll(alive);
    }
  }

  /** Any creature still holding a committed target — a fully-cloaked room
   *  reports zero alive players but ghost-hunters must keep stepping. */
  private anyTargeted(): boolean {
    for (const c of this.crawlers.values()) if (!c.dead && c.tgtValid) return true;
    return false;
  }

  private tick(): void {
    if (!this.field || this.dormant) return;
    const now = performance.now();
    this.tickAcc += Math.min(now - this.lastTickAt, 1000) / 1000;
    this.lastTickAt = now;
    this.tickAcc = Math.min(this.tickAcc, CreatureSim.TICK_CATCHUP_CAP);
    if (this.tickAcc < TICK_DT) return;

    const alive = this.alivePlayers();
    if (alive.length === 0 && !this.anyTargeted()) { this.tickAcc = 0; return; }

    // Drip-feed each declared species toward its own spec cap.
    for (const [species, cap] of Object.entries(this.pops)) {
      if (cap > 0 && this.aliveCount(species) < cap && alive.length) {
        const near = alive[Math.floor(this.rng() * alive.length)]!.pos;
        this.spawnCrawler(near, species);
      }
    }

    while (this.tickAcc >= TICK_DT) {
      this.tickAcc -= TICK_DT;
      this.stepAll(alive);
    }
  }

  private stepAll(alive: { id: string; pos: SimVec }[]): void {
    this.simTime += TICK_DT;
    for (const c of this.crawlers.values()) {
      if (c.dead) continue;
      // A due retarget consumes the whole tick step for this creature —
      // it re-aims first, moves next tick.
      if (this.retargetDue(c, alive)) { this.edge(c, 'retarget'); continue; }
      _snap.x = c.tx; _snap.y = c.ty; _snap.z = c.tz;
      const ev = this.stepBody(c, c.tgtValid ? _snap : null);
      if (ev === 'detonate') { this.kill(c); continue; }
      this.routeEvent(c, ev, alive);
    }
  }

  /** Retarget bookkeeping. Returns true when this tick's step was spent
   *  re-aiming — including the cloak-ghost detour where a creature keeps
   *  hunting the last sighting instead of snapping a U-turn. */
  private retargetDue(c: SimBeing, alive: { id: string; pos: SimVec }[]): boolean {
    const ra = (this.retargetAcc.get(c.id) ?? 0) + TICK_DT;
    if (ra < RETARGET_INTERVAL) { this.retargetAcc.set(c.id, ra); return false; }
    this.retargetAcc.set(c.id, 0);
    const t = this.nearestPlayer(c, alive);
    if (t) {
      c.targetId = t.id;
      this.confuseGhosts.delete(c.id);
      this.snapTarget(c);
      return true;
    }
    this.cloakGhost(c);
    return true;
  }

  /** No visible target: keep hunting a cloaked player's last sighting as
   *  a drifting "ghost" point, else clear the lock entirely. Cloak
   *  breaks the lock, not the scent — the creature reads as searching
   *  confused, and the committed snapshot keeps server + clients
   *  deterministic. */
  private cloakGhost(c: SimBeing): void {
    const prev = c.targetId ? this.players.getPlayer(c.targetId) : null;
    if (prev && !prev.isDead && (prev.status & STATUS.CLOAK) && c.tgtValid) {
      const g = this.confuseGhosts.get(c.id);
      this.confuseGhosts.set(c.id, g
        ? { ...g, until: this.simTime + CONFUSE_TTL }
        : { x: c.tx, y: c.ty, z: c.tz, until: this.simTime + CONFUSE_TTL });
    }
    const g = this.confuseGhosts.get(c.id);
    if (c.tgtValid && g && g.until > this.simTime) {
      const a = this.simTime * 0.9 + (c.id * 131) % 977;
      commitTarget(c, c.targetId, {
        x: g.x + Math.cos(a) * CONFUSE_DRIFT_R,
        y: g.y,
        z: g.z + Math.sin(a) * CONFUSE_DRIFT_R,
      });
      return;
    }
    this.confuseGhosts.delete(c.id);
    c.targetId = null;
    this.snapTarget(c);
  }

  /** One deterministic step — the family picks its own step routine. */
  private stepBody(c: SimBeing, tgt: SimVec | null): CrawlerEvent | null {
    const f = this.field!;
    if (isFlyer(c)) return stepFlyer(c, TICK_DT, f, tgt, true, this.colliders);
    if (isTotem(c)) return stepTotem(c, TICK_DT, f, tgt, true, this.colliders);
    if (isRoller(c)) return stepRoller(c, TICK_DT, f, tgt, true, this.colliders);
    if (isSlither(c)) return stepSlither(c, TICK_DT, f, tgt, true, this.colliders);
    if (isBaneling(c)) return stepBaneling(c, TICK_DT, f, tgt, true, this.colliders);
    return stepCrawler(c, TICK_DT, f, tgt, true, this.colliders);
  }

  /** What the step left behind — an edge to stream, an authoritative
   *  hit to land, or just resync bookkeeping. */
  private routeEvent(c: SimBeing, ev: CrawlerEvent | null, alive: { id: string; pos: SimVec }[]): void {
    if (ev === 'charge' || ev === 'blink' || (ev === 'land' && isTotem(c))) {
      // 'land' doubles as the post-blink resync edge for totems — other
      // families land every hop, so gating it to them would be spam.
      this.edge(c, ev === 'land' ? 'retarget' : ev);
      return;
    }
    if (ev === 'fire' && isTotem(c)) {
      // Authoritative hitscan: sweep LIVE players along the committed
      // beam line — sidestepping after the lock shows is the dodge.
      this.edge(c, 'fire');
      for (const pid of totemFireTargets(c, alive)) {
        this.onBite?.(c, pid);
      }
      c.pendingBite = false;
      return;
    }
    if (ev === 'windup' || ev === 'pounce') { this.edge(c, ev); return; }
    if (ev === 'bite') { this.bite(c); return; }
    const rs = (this.resyncAcc.get(c.id) ?? 0) + TICK_DT;
    if (rs >= RESYNC_INTERVAL) this.edge(c, 'retarget');
    else this.resyncAcc.set(c.id, rs);
  }

  /** A pending bite lands only if the committed target is still
   *  physically next to the creature — without this a confused hunter
   *  pouncing a stale sighting damages a cloaked player across the map. */
  private bite(c: SimBeing): void {
    this.edge(c, 'bite');
    if (!c.pendingBite || !c.targetId) return;
    const live = this.players.getPlayer(c.targetId);
    const near = live && !live.isDead
      && (live.position.x - c.x) ** 2 + (live.position.y - c.y) ** 2 + (live.position.z - c.z) ** 2 < 8 * 8;
    if (near) this.onBite?.(c, c.targetId);
    c.pendingBite = false;
  }
}
