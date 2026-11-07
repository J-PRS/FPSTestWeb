// One owner for "which structure specs are live" — map list plus flag
// stands, minus shield panes whose team's generator is down. Every site
// that used to re-derive the collider surfaces (map load, stand merge)
// funnels through applyStructureSpecs so a mid-match power flip can
// rebuild the identical world without knowing who last wrote it.

import * as THREE from 'three';
import type { StructureSpec } from '../../../shared/mapSpec.js';
import { structureColliders } from '../../../shared/ballCollide.js';
import { ColliderIndex, SolidWorld } from '../../../shared/solidWorld.js';
import { Ball } from '../entities/balls.js';
import { Projectile } from '../projectiles/Projectile.js';
import { setBotStructureSpecs } from './bots/botBrain.js';
import { setShieldPanesOn } from '../world/mapStructures.js';
import { setStructureTopAt } from '../entities/bodyGround.js';

type MoveStructures = { setStructures(l: readonly StructureSpec[] | undefined): void };

let specList: readonly StructureSpec[] = [];
/** Mode-minted structures (offline conquest's node bases) — hull specs
 *  merged over the map's list at every apply. Hosted conquest ships its
 *  node kits IN the wire's structure echo, so this stays empty online. */
let extraList: readonly StructureSpec[] = [];
let move: MoveStructures | undefined = undefined;
const gridDown = new Set<string>();
/** Live structure world for point/footprint ground queries — rebuilt on
 *  the same edge as the collider surfaces so it's never stale vs the
 *  rendered walls. */
let live: SolidWorld | null = null;

/** Highest structure top face under (x,z), -Infinity when none. Mirrors
 *  SolidWorld.topAt — `maxTop` caps which tops count as floor (within
 *  step reach), or standing under a deck reads it as a ceiling, not
 *  ground. The bodyGround lift folds this into terrain height so a body
 *  beside a deck lip/dome cap doesn't bury in it. */
export function structureTopAt(x: number, z: number, maxTop = Infinity): number {
  return live?.topAt(x, z, maxTop) ?? -Infinity;
}

/** Surface normal of the structure the point rests ON: radial on a
 *  dome cap, up on a flat top, null when no structure top is within
 *  reach of y. Same rule the server's tickPad uses for its launch
 *  dir - the visual tilt and the impulse must agree. */
export function structureNormalAt(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 | null {
  if (!live) {return null;}
  for (const c of live.cols) {
    const dx = x - c.cx, dz = z - c.cz;
    let surfY: number, nx = 0, ny = 1, nz = 0;
    if (c.dome) {
      const d2 = dx * dx + dz * dz;
      if (d2 >= c.dome * c.dome) {continue;}
      surfY = (c.cy - c.hy) + Math.sqrt(c.dome * c.dome - d2);
      nx = dx; ny = y - (c.cy - c.hy); nz = dz;
    } else {
      const lx = dx * c.cos + dz * c.sin, lz = -dx * c.sin + dz * c.cos;
      if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) {continue;}
      surfY = c.cy + c.hy;
    }
    if (Math.abs(y - surfY) > 1.5) {continue;}
    return out.set(nx, ny, nz).normalize();
  }
  return null;
}

export function applyStructureSpecs(list: readonly StructureSpec[] | undefined, movement?: MoveStructures): void {
  specList = list ?? [];
  if (movement) {move = movement;}
  const eff = [...specList, ...extraList].filter((s): boolean => s.kind !== 'shield' || !s.team || !gridDown.has(s.team));
  const cols = structureColliders(eff);
  live = cols.length > 0 ? new SolidWorld(cols) : null;
  setStructureTopAt(live ? structureTopAt : undefined);
  Ball.colliders = cols;
  Ball.colliderIndex = cols.length > 0 ? new ColliderIndex(cols) : null;
  Projectile.solidColliders = cols;
  Projectile.solidIndex = Ball.colliderIndex;
  move?.setStructures(eff);
  setBotStructureSpecs(eff);
}

/** Mode-geometry colliders — offline mode bridges feed hull specs here
 *  so their solids block players/bots/balls/shots through the same
 *  pipeline as authored structures. Empty list = no mode solids. */
export function setExtraStructures(list: readonly StructureSpec[]): void {
  extraList = list;
  applyStructureSpecs(specList);
}

/** Bump on every extra-list reset — feeders key their dedupe on it so a
 *  same-content re-feed still lands after a clear (map re-apply edge). */
let extraGen = 0;
export function extraStructGen(): number { return extraGen; }

/** Drop mode solids without reapplying — world rebuilds (gameState /
 *  mapUpdate / solo re-pick) call this before their own apply, so mode
 *  geometry dies with its world instead of leaking onto the next map. */
export function clearExtraStructures(): void { extraList = []; extraGen += 1; }

/** Generator power edge — a team's gate panes drop while its generator
 *  is a hulk (collider AND visual), and come back on revive. */
export function setTeamGridDown(team: string, down: boolean): void {
  if (down === gridDown.has(team)) {return;}
  if (down) {gridDown.add(team);} else {gridDown.delete(team);}
  setShieldPanesOn(team, !down);
  applyStructureSpecs(specList);
}
