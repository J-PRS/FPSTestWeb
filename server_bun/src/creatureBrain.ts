/**
 * CreatureBrain — the per-creature decision loop for CreatureSim:
 * retarget cadence, cloak-ghost hunting, family step dispatch, edge
 * routing, and bite verification. Split out of CreatureSim so the sim
 * file owns lifecycle/spawn/roster while this owns "what does the being
 * do this tick". Deterministic: every choice rides sim-time and the
 * committed snapshot — no wall clock.
 */
import {
  type SimBeing, type CrawlerEvent,
  commitTarget, totemFireTargets,
  isFlyer, isRoller, isSlither, isBaneling, isTotem,
  SPECIES_FAMILY, CRAWLER_SIM,
} from '../../shared/creatureSim.ts';
import type { SimVec, StructureCollider } from '../../shared/ballSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { STATUS, shootRevealed } from '../../shared/status.ts';
import { SIM_TICK_DT } from '../../shared/wire.ts';

const TICK_DT = SIM_TICK_DT;
const RETARGET_INTERVAL = CRAWLER_SIM.RETARGET_S;
// Silence desyncs a wanderer just like a long-flying ball — force a
// resync edge (same committed snapshot) every few seconds.
const RESYNC_INTERVAL = 4;
const _snap: SimVec = { x: 0, y: 0, z: 0 };
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

// SimBeing union + family guards live in shared/creatureSim.ts — re-
// exported here so existing server import sites keep working.
export { isFlyer, isRoller, isSlither, isBaneling, isTotem };
export type { SimBeing };

export interface BrainHost {
  field(): Heightfield;
  colliders(): StructureCollider[] | undefined;
  simTime(): number;
  /** Nearest live, uncloaked candidate (players + injected extras). */
  nearestPlayer(c: SimBeing, alive: { id: string; pos: SimVec }[]): { id: string; pos: SimVec } | null;
  /** Commit the current target snapshot — the wire anchor both ends replay from. */
  snapTarget(c: SimBeing): void;
  /** Stream a committed edge (budgeted inside the sim). */
  edge(c: SimBeing, kind: 'retarget' | 'windup' | 'pounce' | 'bite' | 'detonate' | 'charge' | 'fire' | 'blink'): void;
  /** Authoritative melee/beam damage delivery — Room's damage funnel. */
  onBite?(c: SimBeing, targetId: string): void;
  /** Authoritative kill — detonate consumes the being. */
  kill(c: SimBeing): void;
  /** Live check for the committed target id. */
  playerState(id: string): { isDead: boolean; status: number; lastFireSim: number; position: { x: number; y: number; z: number} } | null;
}

export class CreatureBrain {
  private retargetAcc = new Map<number, number>();
  private confuseGhosts = new Map<number, { x: number; y: number; z: number; until: number }>();
  private resyncAcc = new Map<number, number>();
  /** Shooter's-grudge list: creatures prefer their last damager while the
   *  grudge is fresh — a shot bird shouldn't peel off to the nearest bystander. */
  private grudges = new Map<number, { by: string; until: number }>();
  private static readonly GRUDGE_S = 6;

  constructor(private host: BrainHost) {}

  /** Negative offset pushes a fresh spawn's first retarget into its own
   *  bucket instead of the spawn tick — the spread survives every reset. */
  seedBuckets(id: number): void {
    this.retargetAcc.set(id, -RETARGET_INTERVAL * ((id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
    this.resyncAcc.set(id, -RESYNC_INTERVAL * ((id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
  }

  /** Sim streamed an edge — it doubles as the resync, so the heartbeat
   *  timer restarts. */
  noteEdge(id: number): void {
    this.resyncAcc.set(id, 0);
  }

  /** Creature died — drop all its bookkeeping. */
  forget(id: number): void {
    this.confuseGhosts.delete(id);
    this.retargetAcc.delete(id);
    this.resyncAcc.delete(id);
    this.grudges.delete(id);
  }

  /** A hit lands — the shooter owns the creature's attention until the
   *  grudge expires. Forces the next step's retarget so the turn happens
   *  now, not on the 2s cadence. */
  noteHit(id: number, by: string): void {
    this.grudges.set(id, { by, until: this.host.simTime() + CreatureBrain.GRUDGE_S });
    this.retargetAcc.set(id, RETARGET_INTERVAL);
  }

  stepAll(crawlers: Iterable<SimBeing>, alive: { id: string; pos: SimVec }[]): void {
    for (const c of crawlers) {
      if (c.dead) {continue;}
      // A due retarget consumes the whole tick step for this creature —
      // it re-aims first, moves next tick.
      if (this.retargetDue(c, alive)) { this.host.edge(c, 'retarget'); continue; }
      _snap.x = c.tx; _snap.y = c.ty; _snap.z = c.tz;
      const ev = this.stepBody(c, c.tgtValid ? _snap : null);
      if (ev === 'detonate') { this.host.kill(c); continue; }
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
    // Grudge beats proximity: a fresh damager is the prey until the
    // grudge expires — checked before the nearest-player scan.
    const g = this.grudges.get(c.id);
    if (g) {
      if (g.until <= this.host.simTime()) {this.grudges.delete(c.id);}
      else {
        const st = this.host.playerState(g.by);
        if (st && !st.isDead) {
          c.targetId = g.by;
          this.confuseGhosts.delete(c.id);
          this.host.snapTarget(c);
          return true;
        }
        this.grudges.delete(c.id);
      }
    }
    const t = this.host.nearestPlayer(c, alive);
    if (t) {
      c.targetId = t.id;
      this.confuseGhosts.delete(c.id);
      this.host.snapTarget(c);
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
    const simTime = this.host.simTime();
    const prev = c.targetId ? this.host.playerState(c.targetId) : null;
    // Firing decloaks: a shooter mid-reveal is a live target again, not
    // a ghost — mask the cloak bit by the same window senses use.
    if (prev && !prev.isDead && (prev.status & STATUS.CLOAK) && !shootRevealed(prev.lastFireSim, simTime) && c.tgtValid) {
      const g = this.confuseGhosts.get(c.id);
      this.confuseGhosts.set(c.id, g
        ? ((((((Object.assign({}, g, {until: simTime + CONFUSE_TTL})))))))
        : { x: c.tx, y: c.ty, z: c.tz, until: simTime + CONFUSE_TTL });
    }
    const g = this.confuseGhosts.get(c.id);
    if (c.tgtValid && g && g.until > simTime) {
      const a = simTime * 0.9 + (c.id * 131) % 977;
      commitTarget(c, c.targetId, {
        x: g.x + Math.cos(a) * CONFUSE_DRIFT_R,
        y: g.y,
        z: g.z + Math.sin(a) * CONFUSE_DRIFT_R,
      });
      return;
    }
    this.confuseGhosts.delete(c.id);
    c.targetId = null;
    this.host.snapTarget(c);
  }

  /** One deterministic step — the family picks its own step routine. */
  private stepBody(c: SimBeing, tgt: SimVec | null): CrawlerEvent | null {
    return SPECIES_FAMILY[c.family].step(c, TICK_DT, this.host.field(), tgt, true, this.host.colliders());
  }

  /** What the step left behind — an edge to stream, an authoritative
   *  hit to land, or just resync bookkeeping. */
  private routeEvent(c: SimBeing, ev: CrawlerEvent | null, alive: { id: string; pos: SimVec }[]): void {
    if (ev === 'charge' || ev === 'blink' || (ev === 'land' && isTotem(c))) {
      // 'land' doubles as the post-blink resync edge for totems — other
      // families land every hop, so gating it to them would be spam.
      this.host.edge(c, ev === 'land' ? 'retarget' : ev);
      return;
    }
    if (ev === 'fire' && isTotem(c)) {
      // Authoritative hitscan: sweep LIVE players along the committed
      // beam line — sidestepping after the lock shows is the dodge.
      this.host.edge(c, 'fire');
      for (const pid of totemFireTargets(c, alive)) {
        this.host.onBite?.(c, pid);
      }
      c.pendingBite = false;
      return;
    }
    if (ev === 'windup' || ev === 'pounce') { this.host.edge(c, ev); return; }
    if (ev === 'bite') { this.bite(c); return; }
    const rs = (this.resyncAcc.get(c.id) ?? 0) + TICK_DT;
    if (rs >= RESYNC_INTERVAL) {this.host.edge(c, 'retarget');}
    else {this.resyncAcc.set(c.id, rs);}
  }

  /** A pending bite lands only if the committed target is still
   *  physically next to the creature — without this a confused hunter
   *  pouncing a stale sighting damages a cloaked player across the map. */
  private bite(c: SimBeing): void {
    this.host.edge(c, 'bite');
    if (!c.pendingBite || !c.targetId) {return;}
    const live = this.host.playerState(c.targetId);
    const near = live && !live.isDead
      && (live.position.x - c.x) ** 2 + (live.position.y - c.y) ** 2 + (live.position.z - c.z) ** 2 < 8 * 8;
    if (near) {this.host.onBite?.(c, c.targetId);}
    c.pendingBite = false;
  }
}
