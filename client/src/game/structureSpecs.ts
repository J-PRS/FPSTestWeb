// One owner for "which structure specs are live" — map list plus flag
// stands, minus shield panes whose team's generator is down. Every site
// that used to re-derive the collider surfaces (map load, stand merge)
// funnels through applyStructureSpecs so a mid-match power flip can
// rebuild the identical world without knowing who last wrote it.

import type { StructureSpec } from '../../../shared/mapSpec.js';
import { structureColliders } from '../../../shared/ballCollide.js';
import { ColliderIndex } from '../../../shared/solidWorld.js';
import { Ball } from '../entities/balls.js';
import { Projectile } from '../projectiles/Projectile.js';
import { setBotStructureSpecs } from './botBrain.js';
import { setShieldPanesOn } from '../world/mapStructures.js';

type MoveStructures = { setStructures(l: readonly StructureSpec[] | undefined): void };

let specList: readonly StructureSpec[] = [];
let move: MoveStructures | undefined = undefined;
const gridDown = new Set<string>();

export function applyStructureSpecs(list: readonly StructureSpec[] | undefined, movement?: MoveStructures): void {
  specList = list ?? [];
  if (movement) {move = movement;}
  const eff = specList.filter((s) => s.kind !== 'shield' || !s.team || !gridDown.has(s.team));
  const cols = structureColliders(eff);
  Ball.colliders = cols;
  Ball.colliderIndex = cols.length > 0 ? new ColliderIndex(cols) : null;
  Projectile.solidColliders = cols;
  Projectile.solidIndex = Ball.colliderIndex;
  move?.setStructures(eff);
  setBotStructureSpecs(eff);
}

/** Generator power edge — a team's gate panes drop while its generator
 *  is a hulk (collider AND visual), and come back on revive. */
export function setTeamGridDown(team: string, down: boolean): void {
  if (down === gridDown.has(team)) {return;}
  if (down) {gridDown.add(team);} else {gridDown.delete(team);}
  setShieldPanesOn(team, !down);
  applyStructureSpecs(specList);
}
