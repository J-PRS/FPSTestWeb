import * as THREE from 'three';

import { Crawler } from '../entities/Crawler.js';
import { Scarab } from '../entities/Scarab.js';
import { Rakk } from '../entities/Rakk.js';
import { Roller } from '../entities/Roller.js';
import { Gnat } from '../entities/Gnat.js';
import { Snake } from '../entities/Snake.js';
import { Baneling } from '../entities/Baneling.js';
import { Totem } from '../entities/Totem.js';
import type { Targetable } from '../entities/balls.js';
import type { EntitiesDeps } from './entities.js';
import { Explosion } from '../effects/explosion.js';
import * as sfx from '../core/sfx.js';
import { screenShake } from '../effects/screenShake.js';
import { EXPLOSION_VFX_RADIUS } from '../core/config.js';
import { SIM_TICK_DT } from '../../../shared/wire.js';

export interface NetCrawlersCtx {
  crawlers: Crawler[];
  scarabs: Scarab[];
  rakks: Rakk[];
  rollers: Roller[];
  gnats: Gnat[];
  snakes: Snake[];
  banelings: Baneling[];
  totems: Totem[];
  targets: Targetable[];
}

type NetBeing = Crawler | Scarab | Rakk | Roller | Gnat | Snake | Baneling | Totem;

// Fallback species name when the wire omits one (older servers).
function speciesOf(c: NetBeing): string {
  if (c instanceof Rakk) {return 'rakk';}
  if (c instanceof Gnat) {return 'gnat';}
  if (c instanceof Roller) {return 'roller';}
  if (c instanceof Snake) {return 'snake';}
  if (c instanceof Baneling) {return 'baneling';}
  if (c instanceof Scarab) {return 'scarab';}
  if (c instanceof Totem) {return 'totem';}
  return 'crawler';
}

// ---- Server-owned crawlers (melee PvE) --------------------------------
// Connected rooms with a `creatures` map spec run the authoritative hop
// sim in CreatureSim; crawlSpawn/crawlEvt/crawlDie carry the state edges
// and each client replays shared/creatureSim.ts between them — same
// pattern as netBalls, minus the sim-clock estimation (hops are short
// arcs; committed edges bound drift tightly enough without it).
export function createNetCrawlers(deps: EntitiesDeps, ctx: NetCrawlersCtx) {
  const { crawlers, scarabs, rakks, rollers, gnats, snakes, banelings, totems, targets } = ctx;
  const netCrawlerById = new Map<number, NetBeing>();
  const appliedSkips = new Map<number, number>();
  const serverCreatures = (): boolean => deps.lazyNetworkManager()?.isConnected() ?? false;

  const claim = (netId: number, damage: number) =>
    deps.lazyNetworkManager()?.sendCrawlerHit(netId, damage);
  Crawler.hitClaim = claim;
  Scarab.hitClaim = claim;
  Rakk.hitClaim = claim;
  Roller.hitClaim = claim;
  Gnat.hitClaim = claim;
  Snake.hitClaim = claim;
  Baneling.hitClaim = claim;
  Totem.hitClaim = claim;

  // species → class + home registry + the default sim state it spawns in.
  // Hop, flyer and roller species share the same replay path (netMelee.ts);
  // the class only decides the visuals. bindNet's signature is uniform
  // across classes, so the whole spawn path is one table lookup.
  interface SpeciesEntry {
    Klass: typeof Crawler | typeof Scarab | typeof Rakk | typeof Roller | typeof Gnat | typeof Snake | typeof Baneling | typeof Totem;
    list: NetBeing[];
    state: string;
  }
  const ZERO_VEL = { x: 0, y: 0, z: 0 };
  const SPECIES: Record<string, SpeciesEntry> = {
    crawler:  { Klass: Crawler,  list: crawlers,  state: 'wander'  },
    scarab:   { Klass: Scarab,   list: scarabs,   state: 'wander'  },
    rakk:     { Klass: Rakk,     list: rakks,     state: 'orbit'   },
    roller:   { Klass: Roller,   list: rollers,   state: 'roll'    },
    gnat:     { Klass: Gnat,     list: gnats,     state: 'orbit'   },
    snake:    { Klass: Snake,    list: snakes,    state: 'slither' },
    baneling: { Klass: Baneling, list: banelings, state: 'chase'   },
    totem:    { Klass: Totem,    list: totems,    state: 'aim'     },
  };

  function netCrawlSpawn(m: { id: number; position: { x: number; y: number; z: number }; seed: number; uber: boolean; species?: string; targetId?: string | null; tp?: { x: number; y: number; z: number } | null; state?: string }): void {
    if (netCrawlerById.has(m.id)) {return;}
    const sp = SPECIES[m.species ?? 'crawler'] ?? SPECIES.crawler!;
    const pos = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
    const c = new sp.Klass(deps.scene, deps.lazyTerrain(), pos, m.uber) as NetBeing;
    // A creature whose ctor already marked it dead (swarm slot alloc
    // failed — species/pool not ready) must NOT be registered: staying in
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

  function netCrawlEvt(m: { id: number; kind: 'retarget' | 'windup' | 'pounce' | 'bite' | 'detonate' | 'charge' | 'fire' | 'blink'; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number; sk?: number }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) {return;} // event raced ahead of spawn — roster/spawn covers it
    if (m.kind === 'windup' && c.sim && !(c instanceof Totem)) {(c.sim as { state: string }).state = 'windup';}
    // Server retargetDue() spends the whole tick on the re-aim — the
    // creature takes no step that tick. `sk` is the cumulative count of
    // those skips since spawn, so even a far client that missed edges
    // catches every skipped quantum on the next edge it sees; per-edge
    // guessing would under-correct it by FAR_SKIP-1 (§2.38/§2.39 desync).
    if (m.sk !== undefined) {
      c.netAcc -= SIM_TICK_DT * (m.sk - (appliedSkips.get(m.id) ?? 0));
      appliedSkips.set(m.id, m.sk);
    } else if (m.kind === 'retarget') {
      c.netAcc -= SIM_TICK_DT; // pre-sk server: one skip per retarget edge seen
    }
    c.applyNetEdge({ ...m, kind: m.kind });
    deps.lazyDemoManager()?.recordCreatureEdge(m.id, m.position, m.velocity);
    if (m.kind === 'detonate' && c instanceof Baneling) {
      // The pop is an fx edge only — the server's blast funnel already
      // dealt the damage; crawlDie sweeps the entity right behind it.
      const pos = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
      deps.world.explosions.push(new Explosion(deps.scene, pos, false, 0, deps.lazyTerrain(), c.blastRadius / EXPLOSION_VFX_RADIUS, 0x77FF44));
      sfx.explosionAt(pos, true);
      screenShake.blast(pos, c.uber ? 3.5 : 2, deps.camera.position);
    }
  }

  function netCrawlDie(m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) {return;}
    netCrawlerById.delete(m.id);
    appliedSkips.delete(m.id);
    deps.lazyDemoManager()?.recordCreatureDie(m.id, m.position);
    c.dead = true; // updateSpecies' disposed check sweeps it out
    deps.lazyEffects()?.spawnJumpDust?.(new THREE.Vector3(m.position.x, m.position.y, m.position.z));
  }

  function netCrawlRoster(m: { crawlers: { id: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; uber: boolean; seed: number; species?: string; state: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number }[] }): void {
    const live = new Set<number>();
    for (const r of m.crawlers) {
      live.add(r.id);
      // A dead-but-registered entry is the ctor-fail wedge: evict it so
      // this roster respawns the creature instead of skipping it forever.
      if (netCrawlerById.get(r.id)?.dead) {netCrawlerById.delete(r.id);}
      if (!netCrawlerById.has(r.id)) {
        netCrawlSpawn({ id: r.id, position: r.position, seed: r.seed, uber: r.uber, species: r.species, targetId: r.targetId, tp: r.tp, state: r.state });
      }
      const c = netCrawlerById.get(r.id);
      if (!c) {continue;} // ctor refused (pool not ready) — next roster retries
      c.applyNetEdge({ position: r.position, velocity: r.velocity, kind: 'retarget', targetId: r.targetId, tp: r.tp });
      deps.lazyDemoManager()?.recordCreatureRoster(r.id, r.species ?? speciesOf(c), r.position, r.velocity);
    }
    // Server-truth cull: a crawler we hold that's not on the roster died
    // while our events were in flight.
    for (const [id, c] of netCrawlerById) {
      if (!live.has(id)) {
        netCrawlerById.delete(id);
        appliedSkips.delete(id);
        deps.lazyDemoManager()?.recordCreatureDie(id, c.pos);
        c.dead = true;
      }
    }
  }

  return { serverCreatures, netCrawlSpawn, netCrawlEvt, netCrawlDie, netCrawlRoster };
}
