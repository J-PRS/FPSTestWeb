import * as THREE from 'three';

import { Crawler } from '../entities/Crawler.js';
import type { Targetable } from '../entities/balls.js';
import type { EntitiesDeps } from './entities.js';

export interface NetCrawlersCtx {
  crawlers: Crawler[];
  targets: Targetable[];
}

// ---- Server-owned crawlers (melee PvE) --------------------------------
// Connected rooms with a `creatures` map spec run the authoritative hop
// sim in CreatureSim; crawlSpawn/crawlEvt/crawlDie carry the state edges
// and each client replays shared/creatureSim.ts between them — same
// pattern as netBalls, minus the sim-clock estimation (hops are short
// arcs; committed edges bound drift tightly enough without it).
export function createNetCrawlers(deps: EntitiesDeps, ctx: NetCrawlersCtx) {
  const { crawlers, targets } = ctx;
  const netCrawlerById = new Map<number, Crawler>();
  const serverCreatures = (): boolean => deps.lazyNetworkManager()?.isConnected() ?? false;

  Crawler.hitClaim = (netId, damage) =>
    deps.lazyNetworkManager()?.sendCrawlerHit(netId, damage);

  function netCrawlSpawn(m: { id: number; position: { x: number; y: number; z: number }; seed: number; uber: boolean; targetId?: string | null; tp?: { x: number; y: number; z: number } | null; state?: string }): void {
    if (netCrawlerById.has(m.id)) return;
    const c = new Crawler(deps.scene, deps.lazyTerrain(),
      new THREE.Vector3(m.position.x, m.position.y, m.position.z), m.uber);
    c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
      { x: 0, y: 0, z: 0 }, (m.state as 'wander' | 'chase' | 'windup') ?? 'wander', m.uber);
    if (m.targetId && m.tp) {
      c.applyNetEdge({ position: m.position, velocity: { x: 0, y: 0, z: 0 }, kind: 'retarget', targetId: m.targetId, tp: m.tp });
    }
    crawlers.push(c);
    targets.push(c);
    netCrawlerById.set(m.id, c);
  }

  function netCrawlEvt(m: { id: number; kind: 'retarget' | 'windup' | 'pounce' | 'bite'; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) return; // event raced ahead of spawn — roster/spawn covers it
    if (m.kind === 'windup' && c.sim) c.sim.state = 'windup';
    c.applyNetEdge(m);
  }

  function netCrawlDie(m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
    const c = netCrawlerById.get(m.id);
    if (!c) return;
    netCrawlerById.delete(m.id);
    c.dead = true; // updateSpecies' disposed check sweeps it out
    deps.lazyEffects()?.spawnJumpDust?.(new THREE.Vector3(m.position.x, m.position.y, m.position.z));
  }

  function netCrawlRoster(m: { crawlers: { id: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; uber: boolean; seed: number; state: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null; t?: number }[] }): void {
    const live = new Set<number>();
    for (const r of m.crawlers) {
      live.add(r.id);
      if (!netCrawlerById.has(r.id)) {
        netCrawlSpawn({ id: r.id, position: r.position, seed: r.seed, uber: r.uber, targetId: r.targetId, tp: r.tp, state: r.state });
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
