import * as THREE from 'three';

import { Crawler } from '../entities/Crawler.js';
import { Scarab } from '../entities/Scarab.js';
import { Rakk } from '../entities/Rakk.js';
import { Roller } from '../entities/Roller.js';
import type { Targetable } from '../entities/balls.js';
import type { SimCrawler, SimFlyer } from '../../../shared/creatureSim.js';
import type { EntitiesDeps } from './entities.js';

export interface NetCrawlersCtx {
  crawlers: Crawler[];
  scarabs: Scarab[];
  rakks: Rakk[];
  rollers: Roller[];
  targets: Targetable[];
}

type NetBeing = Crawler | Scarab | Rakk | Roller;

// ---- Server-owned crawlers (melee PvE) --------------------------------
// Connected rooms with a `creatures` map spec run the authoritative hop
// sim in CreatureSim; crawlSpawn/crawlEvt/crawlDie carry the state edges
// and each client replays shared/creatureSim.ts between them — same
// pattern as netBalls, minus the sim-clock estimation (hops are short
// arcs; committed edges bound drift tightly enough without it).
export function createNetCrawlers(deps: EntitiesDeps, ctx: NetCrawlersCtx) {
  const { crawlers, scarabs, rakks, rollers, targets } = ctx;
  const netCrawlerById = new Map<number, NetBeing>();
  const serverCreatures = (): boolean => deps.lazyNetworkManager()?.isConnected() ?? false;

  const claim = (netId: number, damage: number) =>
    deps.lazyNetworkManager()?.sendCrawlerHit(netId, damage);
  Crawler.hitClaim = claim;
  Scarab.hitClaim = claim;
  Rakk.hitClaim = claim;
  Roller.hitClaim = claim;

  // species → entity class. Hop, flyer and roller species share the same
  // replay path (netMelee.ts); the class only decides the visuals.
  const ENTITY_FOR: Record<string, typeof Crawler | typeof Scarab | typeof Rakk | typeof Roller> = {
    crawler: Crawler,
    scarab: Scarab,
    rakk: Rakk,
    roller: Roller,
  };

  function netCrawlSpawn(m: { id: number; position: { x: number; y: number; z: number }; seed: number; uber: boolean; species?: string; targetId?: string | null; tp?: { x: number; y: number; z: number } | null; state?: string }): void {
    if (netCrawlerById.has(m.id)) return;
    const Klass = ENTITY_FOR[m.species ?? 'crawler'] ?? Crawler;
    const c = new Klass(deps.scene, deps.lazyTerrain(),
      new THREE.Vector3(m.position.x, m.position.y, m.position.z), m.uber) as NetBeing;
    if (c instanceof Rakk) {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, ((m.state as SimFlyer['state']) ?? 'orbit'), m.uber, m.species ?? 'rakk');
    } else if (c instanceof Roller) {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, m.state ?? 'roll', m.uber, m.species ?? 'roller');
    } else {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, ((m.state as SimCrawler['state']) ?? 'wander'), m.uber, m.species ?? 'crawler');
    }
    if (m.targetId && m.tp) {
      c.applyNetEdge({ position: m.position, velocity: { x: 0, y: 0, z: 0 }, kind: 'retarget', targetId: m.targetId, tp: m.tp });
    }
    // Route into the species' own registry so its update pass ticks it.
    if (c instanceof Rakk) rakks.push(c);
    else if (c instanceof Roller) rollers.push(c);
    else if (c instanceof Scarab) scarabs.push(c);
    else crawlers.push(c);
    targets.push(c);
    netCrawlerById.set(m.id, c);
  }

  function netCrawlEvt(m: { id: number; kind: 'retarget' | 'windup' | 'pounce' | 'bite'; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) return; // event raced ahead of spawn — roster/spawn covers it
    if (m.kind === 'windup' && c.sim) (c.sim as { state: string }).state = 'windup';
    c.applyNetEdge({ ...m, kind: m.kind });
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
