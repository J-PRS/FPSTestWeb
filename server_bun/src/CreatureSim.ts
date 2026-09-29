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
  type SimCrawler, type SimFlyer, type SimRoller, type CrawlerEvent,
  makeSimCrawler, stepCrawler, applyCrawlerDamage, commitTarget,
  isFlyerSpecies, makeSimFlyer, stepFlyer, applyFlyerDamage,
  isRollerSpecies, makeSimRoller, stepRoller, applyRollerDamage,
  CRAWLER_SIM,
} from '../../shared/creatureSim.ts';
import type { SimVec } from '../../shared/ballSim.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { ServerMessage, Vec3 } from './types.ts';
import { STATUS } from '../../shared/status.ts';
import { logger } from './logger.ts';

const TICK_DT = 0.05;
const RETARGET_INTERVAL = CRAWLER_SIM.RETARGET_S;
// Silence desyncs a wanderer just like a long-flying ball — force a
// resync edge (same committed snapshot) every few seconds.
const RESYNC_INTERVAL = 4.0;
const CRAWLER_BITE_DAMAGE = 25;
const _snap: SimVec = { x: 0, y: 0, z: 0 };
// Distance-tiered send: committed edges only matter to players who can
// see the crawler. Everyone still replays the same sim stream — far
// clients just ride an older committed snapshot longer, which is safe
// because the sim only diverges at decisions and retargets are the
// decisions. NEAR = full fidelity; FAR = every 4th edge (~8s cadence at
// retarget rate).
const NEAR_D2 = 80 * 80;
const FAR_SKIP = 4;
// Brain buckets: retarget/resync decision ticks are staggered across
// BRAIN_BUCKETS phases keyed by creature id, so a pack that all spawned
// on the same tick doesn't dump its O(players) scans + edge fanouts into
// one frame. Classic amortized-AI trick — physics still steps every tick
// (dt can't change without diverging predictors), only decisions
// spread. Re-seeded on spawn so same-tick batches land in different
// buckets.
const BRAIN_BUCKETS = 8;

/** Hop + flyer + roller families share every wire field — the union
 *  only matters at step/damage dispatch, discriminated by family-only
 *  fields (`orbitPhase` = flyer, `hitCd` = roller). */
type SimBeing = SimCrawler | SimFlyer | SimRoller;
const isFlyer = (c: SimBeing): c is SimFlyer => 'orbitPhase' in c;
const isRoller = (c: SimBeing): c is SimRoller => 'hitCd' in c;

export class CreatureSim {
  private field: Heightfield | null = null;
  private crawlers = new Map<number, SimBeing>();
  private nextId = 1;
  private retargetAcc = new Map<number, number>();
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

  /** Bite delivery — Room wires this to the damage funnel. */
  onBite: ((crawler: SimBeing, targetId: string) => void) | null = null;
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
    const ang = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 50;
    const x = near.x + Math.cos(ang) * dist;
    const z = near.z + Math.sin(ang) * dist;
    const seed = (Math.random() * 0xffffffff) >>> 0 || 1;
    const gy = hmHeight(field, x, z);
    const id = this.nextId++;
    const uber = Math.random() < 0.05;
    const c: SimBeing = isFlyerSpecies(species)
      ? makeSimFlyer(id, x, gy, z, uber, seed, species)
      : isRollerSpecies(species)
        ? makeSimRoller(id, x, gy, z, uber, seed, species)
        : makeSimCrawler(id, x, gy, z, uber, seed, species);
    if (isFlyer(c)) c.y = gy + c.sp.ORBIT_ALT; // flyers enter at cruise alt
    if (isRoller(c)) c.y = gy + 1.6;           // rollers ride the surface
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
    } else {
      commitTarget(c, null, null);
    }
  }

  private targetSnap(c: SimBeing): Vec3 | null {
    return c.tgtValid ? { x: c.tx, y: c.ty, z: c.tz } : null;
  }

  private edge(c: SimBeing, kind: 'retarget' | 'windup' | 'pounce' | 'bite'): void {
    this.resyncAcc.set(c.id, 0);
    const msg: ServerMessage = {
      type: 'crawlEvt', id: c.id, kind,
      position: { x: c.x, y: c.y, z: c.z },
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
    const dmg = Math.max(1, Math.min(300, damage));
    const dead = isFlyer(c)
      ? applyFlyerDamage(c, dmg)
      : isRoller(c)
        ? applyRollerDamage(c, dmg)
        : applyCrawlerDamage(c, dmg);
    if (dead) this.kill(c, playerId);
    // Stagger is a timer edge — the next hop decision diverges only if a
    // predictor skips it, and the resync heartbeat bounds that drift.
  }

  private kill(c: SimBeing, by?: string): void {
    c.dead = true;
    this.crawlers.delete(c.id);
    const pos = { x: c.x, y: c.y, z: c.z };
    this.broadcast({ type: 'crawlDie', id: c.id, position: pos, by: by ?? null });
    if (by) this.onKilled?.(by, pos);
  }

  private tick(): void {
    if (!this.field || this.dormant) return;
    const now = performance.now();
    this.tickAcc += Math.min(now - this.lastTickAt, 1000) / 1000;
    this.lastTickAt = now;
    this.tickAcc = Math.min(this.tickAcc, CreatureSim.TICK_CATCHUP_CAP);
    if (this.tickAcc < TICK_DT) return;

    const alive = this.alivePlayers();
    if (alive.length === 0) { this.tickAcc = 0; return; }

    // Drip-feed each declared species toward its own spec cap.
    for (const [species, cap] of Object.entries(this.pops)) {
      if (cap > 0 && this.aliveCount(species) < cap) {
        const near = alive[Math.floor(Math.random() * alive.length)]!.pos;
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

      const ra = (this.retargetAcc.get(c.id) ?? 0) + TICK_DT;
      if (ra >= RETARGET_INTERVAL) {
        this.retargetAcc.set(c.id, 0);
        const t = this.nearestPlayer(c, alive);
        c.targetId = t?.id ?? null;
        this.snapTarget(c);
        this.edge(c, 'retarget');
        continue;
      }
      this.retargetAcc.set(c.id, ra);

      _snap.x = c.tx; _snap.y = c.ty; _snap.z = c.tz;
      const tgt = c.tgtValid ? _snap : null;
      const ev: CrawlerEvent | null = isFlyer(c)
        ? stepFlyer(c, TICK_DT, this.field!, tgt, true)
        : isRoller(c)
          ? stepRoller(c, TICK_DT, this.field!, tgt, true)
          : stepCrawler(c, TICK_DT, this.field!, tgt, true);
      if (ev === 'windup' || ev === 'pounce') {
        this.edge(c, ev);
      } else if (ev === 'bite') {
        this.edge(c, 'bite');
        if (c.pendingBite && c.targetId) {
          this.onBite?.(c, c.targetId);
          c.pendingBite = false;
        }
      } else {
        const rs = (this.resyncAcc.get(c.id) ?? 0) + TICK_DT;
        if (rs >= RESYNC_INTERVAL) this.edge(c, 'retarget');
        else this.resyncAcc.set(c.id, rs);
      }
    }
  }
}
