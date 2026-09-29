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
import { ROCKET_RADIUS } from '../core/config.js';

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
  if (c instanceof Rakk) return 'rakk';
  if (c instanceof Gnat) return 'gnat';
  if (c instanceof Roller) return 'roller';
  if (c instanceof Snake) return 'snake';
  if (c instanceof Baneling) return 'baneling';
  if (c instanceof Scarab) return 'scarab';
  if (c instanceof Totem) return 'totem';
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
    if (netCrawlerById.has(m.id)) return;
    const sp = SPECIES[m.species ?? 'crawler'] ?? SPECIES.crawler!;
    const pos = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
    const c = new sp.Klass(deps.scene, deps.lazyTerrain(), pos, m.uber) as NetBeing;
    // Each class narrows `state` to its sim's enum; through the union the
    // overloads don't merge, so bind through the shared (string) shape.
    type BindNetArgs = [id: number, seed: number, pos: THREE.Vector3, vel: { x: number; y: number; z: number }, state: string, uber: boolean, species?: string];
    const bindNet = c.bindNet as (...a: BindNetArgs) => void;
    bindNet.call(c, m.id, m.seed, pos, ZERO_VEL, m.state ?? sp.state, m.uber, m.species ?? speciesOf(c));
    if (m.targetId && m.tp) {
      c.applyNetEdge({ position: m.position, velocity: ZERO_VEL, kind: 'retarget', targetId: m.targetId, tp: m.tp });
    }
    sp.list.push(c);
    targets.push(c);
    netCrawlerById.set(m.id, c);
  }

  function netCrawlEvt(m: { id: number; kind: 'retarget' | 'windup' | 'pounce' | 'bite' | 'detonate' | 'charge' | 'fire' | 'blink'; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) return; // event raced ahead of spawn — roster/spawn covers it
    if (m.kind === 'windup' && c.sim && !(c instanceof Totem)) (c.sim as { state: string }).state = 'windup';
    c.applyNetEdge({ ...m, kind: m.kind });
    if (m.kind === 'detonate' && c instanceof Baneling) {
      // The pop is an fx edge only — the server's blast funnel already
      // dealt the damage; crawlDie sweeps the entity right behind it.
      const pos = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
      deps.world.explosions.push(new Explosion(deps.scene, pos, false, 0, deps.lazyTerrain(), c.blastRadius / ROCKET_RADIUS, 0x77ff44));
      sfx.explosionAt(pos, true);
      screenShake.blast(pos, c.uber ? 3.5 : 2.0, deps.camera.position);
    }
  }

  function netCrawlDie(m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) return;
    netCrawlerById.delete(m.id);
    c.dead = true; // updateSpecies' disposed check sweeps it out
    deps.lazyEffects()?.spawnJumpDust?.(new THREE.Vector3(m.position.x, m.position.y, m.position.z));
  }

  function netCrawlRoster(m: { crawlers: { id: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; uber: boolean; seed: number; species?: string; state: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number }[] }): void {
    const live = new Set<number>();
    for (const r of m.crawlers) {
      live.add(r.id);
      if (!netCrawlerById.has(r.id)) {
        netCrawlSpawn({ id: r.id, position: r.position, seed: r.seed, uber: r.uber, species: r.species, targetId: r.targetId, tp: r.tp, state: r.state });
      }
      const c = netCrawlerById.get(r.id)!;
      c.applyNetEdge({ position: r.position, velocity: r.velocity, kind: 'retarget', targetId: r.targetId, tp: r.tp });
    }
    // Server-truth cull: a crawler we hold that's not on the roster died
    // while our events were in flight.
    for (const [id, c] of netCrawlerById) {
      if (!live.has(id)) { netCrawlerById.delete(id); c.dead = true; }
    }
  }

  return { serverCreatures, netCrawlSpawn, netCrawlEvt, netCrawlDie, netCrawlRoster };
}
