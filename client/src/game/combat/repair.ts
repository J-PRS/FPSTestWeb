import * as THREE from 'three';

import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import { REPAIR_RANGE, REPAIR_HEAL_PER_TICK, WeaponType } from '../../../../shared/weapons.js';
import { segSolidHit } from '../../../../shared/solidWorld.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { CombatDeps } from '../combat.js';
import type { FireEvent } from '../../entities/Player.js';
import type { Item } from '../deployables.js';

// Repair tool — the technician's sidearm. A short green beam that heals
// a friendly deployable per tick, overflow banking as armor (see
// REPAIR_* in shared/weapons). Same honest-hitscan shape as the LG:
// eye ray → terrain/solid clip → padded sphere pick on the item body.
// The heal claim carries only the item's wire id — the server re-derives
// range, LOS, team, heal amount, and pacing itself.

const _o = new THREE.Vector3();     // eye — the honest ray origin
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();     // terrain march point
const _muzzle = new THREE.Vector3();

interface RepairState {
  beam: LightningBeam | null;
  lastFire: number;
  beamTo: THREE.Vector3;
}

function repairTrace(deps: CombatDeps, cam: THREE.Camera): { hitT: number; item: Item | null } {
  _o.copy(cam.position);
  cam.getWorldDirection(_d);

  // Terrain: march the ray in 0.75m steps until it goes under the heightmap
  let hitT = REPAIR_RANGE;
  for (let d = 0.75; d <= REPAIR_RANGE; d += 0.75) {
    _p.copy(_o).addScaledVector(_d, d);
    if (_p.y < deps.lazyTerrain().getHeight(_p.x, _p.z)) { hitT = d; break; }
  }

  // Walls stop the weld — same rule as the LG (a beam through a base
  // would heal things the shooter can't see, and the server rejects it).
  if (Projectile.solidColliders.length) {
    _p.copy(_o).addScaledVector(_d, hitT);
    const sh = segSolidHit(_o, _p, Projectile.solidColliders);
    if (sh) hitT *= sh.t;
  }

  const hit = deps.lazyDeployables?.().repairHit(_o, _d, hitT) ?? null;
  return { hitT: hit ? hit.t : hitT, item: hit?.item ?? null };
}

export function createRepair(deps: CombatDeps) {
  const st: RepairState = { beam: null, lastFire: 0, beamTo: new THREE.Vector3() };

  function muzzle(cam: THREE.Camera): void {
    // Same third-person rule as the LG: hidden viewmodel ≠ a muzzle —
    // anchor the weld at the body model's barrel tip.
    const player = deps.lazyPlayer();
    if (player.thirdPerson && player.muzzleWorld(_muzzle)) return;
    if (!deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.Repair, cam, _muzzle)) {
      lgMuzzleAnchor(cam, _muzzle);
    }
  }

  // One beam tick — heal + claim. The visual weld runs every frame in
  // updateBeamVisual (post-viewModel), same split as the LG.
  function repair(_e: FireEvent): void {
    const cam = deps.lazyCamera();
    if (!st.beam) {
      st.beam = new LightningBeam(deps.lazyScene(), {
        glow: 0x1fbb66, core: 0xdcffe8, chain: 0x7dffb8, hit: 0xaaffcc, sparkTop: 0x66ffaa,
      });
    }
    st.lastFire = performance.now();
    const hit = repairTrace(deps, cam);
    st.beamTo.copy(_o).addScaledVector(_d, hit.hitT);
    if (hit.item) {
      // Predicted heal — the deployHp echo lands the same number; an
      // unreachable claim just snaps back on the next broadcast.
      deps.lazyDeployables?.().healItem(hit.item, REPAIR_HEAL_PER_TICK);
      const nm = deps.lazyNetworkManager();
      if (hit.item.serverId !== undefined && nm?.isConnected()) nm.sendRepair(hit.item.serverId);
      deps.lazyDamageNumbers().spawn(hit.item.pos, REPAIR_HEAL_PER_TICK, '#7dffb8', cam);
    }
    muzzle(cam);
    st.beam.fire(_muzzle, st.beamTo, cam.position, hit.item !== null, hit.item !== null);
  }

  // Per-frame beam refresh — re-trace so the tip tracks the item (a
  // drone on the move) instead of staling between 100ms ticks.
  function updateBeamVisual(): void {
    if (!st.beam || st.lastFire <= 0 || performance.now() - st.lastFire > 90) return;
    const cam = deps.lazyCamera();
    muzzle(cam);
    const hit = repairTrace(deps, cam);
    st.beamTo.copy(_o).addScaledVector(_d, hit.hitT);
    st.beam.fire(_muzzle, st.beamTo, cam.position, hit.item !== null, hit.item !== null);
  }

  // Beam fades ~90ms after the last tick — driven from updateProjectiles.
  function tickBeam(dt: number): void {
    if (!st.beam) return;
    st.beam.update(dt);
    if (st.lastFire > 0 && performance.now() - st.lastFire > 90) st.lastFire = 0;
  }

  return { repair, updateBeamVisual, tickBeam };
}
