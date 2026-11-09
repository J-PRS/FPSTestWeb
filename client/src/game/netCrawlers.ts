import * as THREE from 'three';

import { Crawler } from '../entities/Crawler.js';
import { Scarab } from '../entities/Scarab.js';
import { Rakk } from '../entities/Rakk.js';
import { Roller } from '../entities/Roller.js';
import { Gnat } from '../entities/Gnat.js';
import { Snake } from '../entities/Snake.js';
import { Baneling } from '../entities/Baneling.js';
import { Totem } from '../entities/Totem.js';
import { Buzzard } from '../entities/Buzzard.js';
import type { Targetable } from '../entities/balls.js';
import { finiteVec as finite, SIM_TICK_DT } from '../../../shared/wire.js';
import { seedReplicaState } from './netMelee.js';
import type { EntitiesDeps } from './entities.js';
import { Explosion } from '../effects/explosion.js';
import * as sfx from '../core/sfx.js';
import { screenShake } from '../effects/screenShake.js';
import { reconcileReplicas } from './replicas.js';
import { EXPLOSION_VFX_RADIUS } from '../core/config.js';

export interface NetCrawlersCtx {
  crawlers: Crawler[];
  scarabs: Scarab[];
  rakks: Rakk[];
  rollers: Roller[];
  gnats: Gnat[];
  snakes: Snake[];
  banelings: Baneling[];
  totems: Totem[];
  buzzards: Buzzard[];
  targets: Targetable[];
}

type NetBeing = Crawler | Scarab | Rakk | Roller | Gnat | Snake | Baneling | Totem | Buzzard;

// Fallback species name when the wire omits one (older servers).
function speciesOf(c: NetBeing): string {
  return c.species ?? 'crawler';
}

// ---- Server-owned crawlers (melee PvE) --------------------------------
// Connected rooms with a `creatures` map spec run the authoritative hop
// sim in CreatureSim; crawlSpawn/crawlEvt/crawlDie carry the state edges
// and each client replays shared/creatureSim.ts between them - same
// pattern as netBalls, minus the sim-clock estimation (hops are short
// arcs; committed edges bound drift tightly enough without it).
/** Wire-species registry - entity class, the ctx list that owns it,
 *  and its default spawn state. SPECIES below and demoLifecycle's
 *  playback pairs both derive here; a new wire species = one row. */
export const WIRE_SPECIES: Record<string, { Klass: typeof Crawler | typeof Scarab | typeof Rakk | typeof Roller | typeof Gnat | typeof Snake | typeof Baneling | typeof Totem | typeof Buzzard; ctxKey: keyof NetCrawlersCtx; state: string }> = {
  crawler:  { Klass: Crawler,  ctxKey: 'crawlers',  state: 'wander'  },
  scarab:   { Klass: Scarab,   ctxKey: 'scarabs',   state: 'wander'  },
  rakk:     { Klass: Rakk,     ctxKey: 'rakks',     state: 'orbit'   },
  roller:   { Klass: Roller,   ctxKey: 'rollers',   state: 'roll'    },
  gnat:     { Klass: Gnat,     ctxKey: 'gnats',     state: 'orbit'   },
  snake:    { Klass: Snake,    ctxKey: 'snakes',    state: 'slither' },
  baneling: { Klass: Baneling, ctxKey: 'banelings', state: 'chase'   },
  totem:    { Klass: Totem,    ctxKey: 'totems',    state: 'aim'     },
  buzzard:  { Klass: Buzzard,  ctxKey: 'buzzards',  state: 'orbit'   },
};

export function createNetCrawlers(deps: EntitiesDeps, ctx: NetCrawlersCtx) {
  const { targets } = ctx; // species lists resolve through ctx[ctxKey] in SPECIES below
  const netCrawlerById = new Map<number, NetBeing>();
  const appliedSkips = new Map<number, number>();
  // Stamp order per creature: emit order IS stamp order, so an edge with
  // an older t than the newest applied is a WAN reorder - applying it
  // overwrites fresher position/target with stale truth (the fuzz's
  // 110m stale-chase). Balls gate reorders the same way (isStaleSeg).
  const lastEvtT = new Map<number, number>();
  // A P2P host carries no creature sim - peers keep client-side species.
  const serverCreatures = (): boolean => deps.lazyNetworkManager()?.authoritySims() ?? false;

  const claim = (netId: number, damage: number): void =>
    deps.lazyNetworkManager()?.sendCrawlerHit(netId, damage);
  for (const sp of Object.values(WIRE_SPECIES)) {sp.Klass.hitClaim = claim;}

  // species → class + home registry + the default sim state it spawns in.
  // Hop, flyer and roller species share the same replay path (netMelee.ts);
  // the class only decides the visuals. bindNet's signature is uniform
  // across classes, so the whole spawn path is one table lookup.
  interface SpeciesEntry {
    Klass: typeof Crawler | typeof Scarab | typeof Rakk | typeof Roller | typeof Gnat | typeof Snake | typeof Baneling | typeof Totem | typeof Buzzard;
    list: NetBeing[];
    state: string;
  }
  const ZERO_VEL = { x: 0, y: 0, z: 0 };
  const SPECIES: Record<string, SpeciesEntry> = Object.fromEntries(
    Object.entries(WIRE_SPECIES).map(([k, v]): [string, SpeciesEntry] => [
      k, { Klass: v.Klass, list: ctx[v.ctxKey] as NetBeing[], state: v.state }])) as Record<string, SpeciesEntry>;

  // Non-finite authority state silently poisons the replay sim - drop
  // the edge and warn (server fault, hostile p2p peer). `finite` is
  // shared/wire's finiteVec under its call-site name.

  function netCrawlSpawn(m: { id: number; position: { x: number; y: number; z: number }; seed: number; uber: boolean; species?: string; targetId?: string | null; tp?: { x: number; y: number; z: number } | null; state?: string }): void {
    if (!finite(m.position) || (m.tp && !finite(m.tp))) {deps.logger.warn(`crawl spawn #${m.id} dropped: non-finite vector`); return;}
    if (netCrawlerById.has(m.id)) {return;}
    const sp = SPECIES[m.species ?? 'crawler'] ?? SPECIES.crawler!;
    const pos = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
    const c = new sp.Klass(deps.scene, deps.lazyTerrain(), pos, m.uber) as NetBeing;
    // A creature whose ctor already marked it dead (swarm slot alloc
    // failed - species/pool not ready) must NOT be registered: staying in
    // netCrawlerById makes every later roster skip the respawn and leaves
    // the entity wedged invisible forever.
    if (c.dead) {return;}
    c.bindNet({ id: m.id, seed: m.seed, pos, vel: ZERO_VEL, state: m.state ?? sp.state, uber: m.uber, species: m.species ?? speciesOf(c) });
    if (m.targetId && m.tp) {
      c.applyNetEdge({ position: m.position, velocity: ZERO_VEL, kind: 'retarget', targetId: m.targetId, tp: m.tp });
    }
    sp.list.push(c);
    targets.push(c);
    netCrawlerById.set(m.id, c);
    deps.lazyDemoManager()?.recordCreatureSpawned(m.id, m.species ?? speciesOf(c), m.position);
  }

  function netCrawlEvt(m: { id: number; kind: 'retarget' | 'windup' | 'pounce' | 'bite' | 'detonate' | 'charge' | 'fire' | 'blink'; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number; sk?: number; seed?: number }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) {return;} // event raced ahead of spawn - roster/spawn covers it
    if (!finite(m.position) || !finite(m.velocity) || (m.tp && !finite(m.tp))) {deps.logger.warn(`crawl #${m.id} ${m.kind} dropped: non-finite vector`); return;}
    if (m.t !== undefined && m.t < (lastEvtT.get(m.id) ?? -Infinity)) {return;} // WAN reorder - stale snap would overwrite fresher truth
    if (m.t !== undefined) {lastEvtT.set(m.id, m.t);}
    if (m.kind === 'windup' && c.sim && !(c instanceof Totem)) {seedReplicaState(c.sim, 'windup');}
    // Server retargetDue() spends the whole tick on the re-aim - the
    // creature takes no step that tick. `sk` is the cumulative count of
    // those skips since spawn, so even a far client that missed edges
    // catches every skipped quantum on the next edge it sees; per-edge
    // guessing would under-correct it by FAR_SKIP-1 (§2.38/§2.39 desync).
    if (m.sk !== undefined && Number.isFinite(m.sk)) {
      c.netAcc -= SIM_TICK_DT * (m.sk - (appliedSkips.get(m.id) ?? 0));
      appliedSkips.set(m.id, m.sk);
    } else if (m.sk === undefined && m.kind === 'retarget') {
      c.netAcc -= SIM_TICK_DT; // pre-sk server: one skip per retarget edge seen
    }
    c.applyNetEdge(Object.assign({}, m, {kind: m.kind}));
    // Live LCG rides every edge (roster contract, now on evts too): a
    // missed edge that consumed a crand draw would offset the replica's
    // whole cooldown stream permanently - re-sync on arrival instead.
    if (c.sim && m.seed !== undefined && Number.isFinite(m.seed)) {
      (c.sim as { rng: number }).rng = m.seed;
    }
    deps.lazyDemoManager()?.recordCreatureEdge(m.id, m.position, m.velocity);
    if (m.kind === 'detonate' && c instanceof Baneling) {
      // The pop is an fx edge only - the server's blast funnel already
      // dealt the damage; crawlDie sweeps the entity right behind it.
      const pos = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
      deps.world.explosions.push(new Explosion(deps.scene, pos, false, 0, deps.lazyTerrain(), c.blastRadius / EXPLOSION_VFX_RADIUS, 0x77_FF_44));
      sfx.explosionAt(pos, true);
      screenShake.blast(pos, c.uber ? 3.5 : 2, deps.camera.position);
    }
  }

  function netCrawlDie(m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) {return;}
    const mm = finite(m.position) ? m : Object.assign({}, m, {position: {x: c.pos.x, y: c.pos.y, z: c.pos.z}});
    netCrawlerById.delete(mm.id);
    appliedSkips.delete(m.id);
    lastEvtT.delete(m.id);
    deps.lazyDemoManager()?.recordCreatureDie(m.id, m.position);
    c.dead = true; // updateSpecies' disposed check sweeps it out
    deps.lazyEffects()?.spawnJumpDust?.(new THREE.Vector3(m.position.x, m.position.y, m.position.z));
  }

  function netCrawlRoster(m: { crawlers: { id: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; uber: boolean; seed: number; species?: string; state: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number; sk?: number; ph?: number; od?: number }[] }): void {
    reconcileReplicas(netCrawlerById, m.crawlers, {
      rowId: (r): number => r.id,
      isDead: (c): boolean => c.dead,
      ensure: (r): NetBeing | undefined => {
        netCrawlSpawn({ id: r.id, position: r.position, seed: r.seed, uber: r.uber, species: r.species, targetId: r.targetId, tp: r.tp, state: r.state });
        // Roster-born replicas inherit the row's absolute skip count -
        // seeding 0 would replay every past retarget skip again.
        if (r.sk !== undefined && Number.isFinite(r.sk)) {appliedSkips.set(r.id, r.sk);}
        return netCrawlerById.get(r.id);
      },
      apply: (c, r): void => {
        // Species+uber are constructor-fixed: a wrong replica (id
        // recycled, corrupt spawn edge) can never patch its way to truth
        // - the roster is authoritative, so kill it and respawn the
        // server's row instead of desyncing forever.
        if ((r.species && r.species !== speciesOf(c)) || r.uber !== c.uber) {
          netCrawlerById.delete(r.id);
          appliedSkips.delete(r.id);
          lastEvtT.delete(r.id);
          c.dead = true; // updateSpecies' disposed check sweeps it out
          netCrawlSpawn({ id: r.id, position: r.position, seed: r.seed, uber: r.uber, species: r.species, targetId: r.targetId, tp: r.tp, state: r.state });
          if (r.sk !== undefined && Number.isFinite(r.sk)) {appliedSkips.set(r.id, r.sk);}
          return;
        }
        // sk heals the skip budget edges would have incremented - a
        // roster row carries the server's absolute count, so missed
        // retarget edges re-credit the quanta here instead of drifting
        // the replay clock ahead forever.
        if (r.sk !== undefined && Number.isFinite(r.sk)) {
          c.netAcc -= SIM_TICK_DT * (r.sk - (appliedSkips.get(r.id) ?? 0));
          appliedSkips.set(r.id, r.sk);
        }
        // Same wire law as netCrawlEvt: a NaN roster row would write
        // straight into the sim - the per-evt gate never sees this path.
        if (finite(r.position) && finite(r.velocity) && (!r.tp || finite(r.tp))) {
          c.applyNetEdge({ position: r.position, velocity: r.velocity, kind: 'retarget', targetId: r.targetId, tp: r.tp });
        } else {
          deps.logger.warn(`crawler #${r.id} roster edge dropped: non-finite vector`);
        }
        // A retarget edge carries no state label - a replica that missed a
        // windup/pounce/blink edge replays a different state machine and
        // strands on it permanently (the soak's persistent state desyncs).
        // The roster row IS the committed label; seeding it lets the next
        // tick resume from truth. Transitory timers (windupTimer et al.)
        // expire quickly either way - a wrong-state tick heals on the next
        // edge, a wrong label never does.
        if (r.state && c.sim && c.sim.state !== r.state) {
          seedReplicaState(c.sim, r.state);
        }
        // The row's `seed` is the server's LIVE LCG state, not the spawn
        // seed - a missed edge that consumed a crand draw offsets the
        // replica's whole stream permanently (every later cooldown diverges).
        if (c.sim && Number.isFinite(r.seed)) {
          (c.sim as { rng: number }).rng = r.seed;
        }
        // Flyer orbit phase/dir steer the anchor every tick yet never ride
        // an edge - without them a stun pause or missed edge offsets the
        // replica's orbit by up to 2*ORBIT_R forever.
        if (c.sim && r.ph !== undefined && Number.isFinite(r.ph)) {
          const fly = c.sim as { orbitPhase?: number; orbitDir?: number };
          if (fly.orbitPhase !== undefined) {fly.orbitPhase = r.ph;}
          if (r.od !== undefined && fly.orbitDir !== undefined) {fly.orbitDir = r.od as 1 | -1;}
        }
        deps.lazyDemoManager()?.recordCreatureRoster(r.id, r.species ?? speciesOf(c), r.position, r.velocity);
      },
      // Server-truth cull: a crawler we hold that's not on the roster died
      // while our events were in flight.
      reap: (c, id): void => {
        appliedSkips.delete(id);
        deps.lazyDemoManager()?.recordCreatureDie(id, c.pos);
        c.dead = true;
      },
    });
  }

  return { serverCreatures, netCrawlSpawn, netCrawlEvt, netCrawlDie, netCrawlRoster };
}
