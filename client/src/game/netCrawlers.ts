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
import type { SimCrawler, SimFlyer } from '../../../shared/creatureSim.js';
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

  // species → entity class. Hop, flyer and roller species share the same
  // replay path (netMelee.ts); the class only decides the visuals.
  const ENTITY_FOR: Record<string, typeof Crawler | typeof Scarab | typeof Rakk | typeof Roller | typeof Gnat | typeof Snake | typeof Baneling | typeof Totem> = {
    crawler: Crawler,
    scarab: Scarab,
    rakk: Rakk,
    roller: Roller,
    gnat: Gnat,
    snake: Snake,
    baneling: Baneling,
    totem: Totem,
  };

  function netCrawlSpawn(m: { id: number; position: { x: number; y: number; z: number }; seed: number; uber: boolean; species?: string; targetId?: string | null; tp?: { x: number; y: number; z: number } | null; state?: string }): void {
    if (netCrawlerById.has(m.id)) return;
    const Klass = ENTITY_FOR[m.species ?? 'crawler'] ?? Crawler;
    const c = new Klass(deps.scene, deps.lazyTerrain(),
      new THREE.Vector3(m.position.x, m.position.y, m.position.z), m.uber) as NetBeing;
    if (c instanceof Rakk || c instanceof Gnat) {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, ((m.state as SimFlyer['state']) ?? 'orbit'), m.uber, m.species ?? (c instanceof Gnat ? 'gnat' : 'rakk'));
    } else if (c instanceof Roller) {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, m.state ?? 'roll', m.uber, m.species ?? 'roller');
    } else if (c instanceof Snake) {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, m.state ?? 'slither', m.uber, m.species ?? 'snake');
    } else if (c instanceof Baneling) {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, m.state ?? 'chase', m.uber, m.species ?? 'baneling');
    } else if (c instanceof Totem) {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, m.state ?? 'aim', m.uber);
    } else {
      c.bindNet(m.id, m.seed, new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        { x: 0, y: 0, z: 0 }, ((m.state as SimCrawler['state']) ?? 'wander'), m.uber, m.species ?? 'crawler');
    }
    if (m.targetId && m.tp) {
      c.applyNetEdge({ position: m.position, velocity: { x: 0, y: 0, z: 0 }, kind: 'retarget', targetId: m.targetId, tp: m.tp });
    }
    // Route into the species' own registry so its update pass ticks it.
    if (c instanceof Rakk) rakks.push(c);
    else if (c instanceof Gnat) gnats.push(c);
    else if (c instanceof Snake) snakes.push(c);
    else if (c instanceof Baneling) banelings.push(c);
    else if (c instanceof Roller) rollers.push(c);
    else if (c instanceof Scarab) scarabs.push(c);
    else if (c instanceof Totem) totems.push(c);
    else crawlers.push(c);
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
