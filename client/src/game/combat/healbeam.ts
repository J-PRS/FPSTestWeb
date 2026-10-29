import * as THREE from 'three';

import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import { HEALBEAM_RANGE, HEALBEAM_PER_TICK, HEALBEAM_ENERGY, WeaponType } from '../../../../shared/weapons.js';
import { lgTrace } from './lightningTrace.js';
import type { CombatDeps } from '../combat.js';
import type { FireEvent } from '../../entities/Player.js';

// Heal beam — the medic's pocket beam. Same honest ray as the LG
// (lgTrace already marches terrain, clips solids, and capsule-tests
// remote players): if the earliest contact is a teammate, the server
// pays HEALBEAM_PER_TICK off the same shotFired intent — the claim
// carries no amount and no target, so the client's beam, numbers, and
// energy drain are all prediction the wire echo lands.
//
// The ammo is jet energy — a full tank is ~16s of beam, so pocket-
// healing a push taxes the healer's own mobility (HEALBEAM_ENERGY/tick).

const _muzzle = new THREE.Vector3();
const _hitPos = new THREE.Vector3();
const _ghost = new THREE.Vector3();
const _lgT = { t: 0 };

interface HealState {
  beam: LightningBeam | null;
  lastFire: number;
  beamTo: THREE.Vector3;
}

export function createHealBeam(deps: CombatDeps) {
  const st: HealState = { beam: null, lastFire: 0, beamTo: new THREE.Vector3() };

  function muzzle(cam: THREE.Camera): void {
    const player = deps.lazyPlayer();
    if (player.thirdPerson && player.muzzleWorld(_muzzle)) {return;}
    if (!deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.HealBeam, cam, _muzzle)) {
      lgMuzzleAnchor(cam, _muzzle);
    }
  }

  /** Earliest honest contact — returns the teammate hit, or null when
   *  the ray's first touch is anything else (enemy, creature, wall). */
  function traceHeal(cam: THREE.Camera): { hitId: string | null; hitT: number } {
    const res = lgTrace(deps, cam, _lgT, HEALBEAM_RANGE, false);
    if (!res.hitPlayerId) {return { hitId: null, hitT: res.hitT };}
    const nm = deps.lazyNetworkManager?.();
    const team = nm?.getPlayers().get(res.hitPlayerId)?.team;
    return { hitId: team !== undefined && team === deps.world.localTeam ? res.hitPlayerId : null, hitT: res.hitT };
  }

  function heal(e: FireEvent): void {
    const p = deps.lazyPlayer();
    // Dry tank refuses the tick — the server gates on the same tank;
    // refusing here keeps the beam honest before the echo lands.
    if (p.energy < HEALBEAM_ENERGY) {return;}
    const cam = deps.lazyCamera();
    if (!st.beam) {
      // Clinical cyan-white — distinct from the repair tool's weld-green.
      st.beam = new LightningBeam(deps.lazyScene(), {
        glow: 0x2F_88_DD, core: 0xE8_F8_FF, chain: 0x8F_D8_FF, hit: 0xBB_EE_FF, sparkTop: 0x77_CC_FF,
      });
    }
    st.lastFire = performance.now();
    const hit = traceHeal(cam);
    if (hit.hitId) {
      const rp = deps.world.remotePlayers.get(hit.hitId);
      if (rp) {
        _hitPos.copy(rp.ghostPosition?.(_ghost) ?? rp.position);
        _hitPos.y += 1;
        deps.lazyDamageNumbers().spawn(_hitPos, HEALBEAM_PER_TICK, '#8fd8ff', cam);
      }
      st.beamTo.copy(_hitPos);
    } else {
      const o = cam.position;
      const d = cam.getWorldDirection(new THREE.Vector3());
      st.beamTo.copy(o).addScaledVector(d, hit.hitT);
    }
    // Predicted tank drain — the server writes the real tank on the same
    // tick; the local floor keeps the beam feeling the cost immediately.
    p.energy = Math.max(0, p.energy - HEALBEAM_ENERGY);
    muzzle(cam);
    st.beam.fire(_muzzle, st.beamTo, cam.position, hit.hitId !== null, hit.hitId !== null);
  }

  function updateBeamVisual(): void {
    if (!st.beam || st.lastFire <= 0 || performance.now() - st.lastFire > 90) {return;}
    const cam = deps.lazyCamera();
    muzzle(cam);
    const hit = traceHeal(cam);
    if (hit.hitId) {
      const rp = deps.world.remotePlayers.get(hit.hitId);
      if (rp) {_hitPos.copy(rp.ghostPosition?.(_ghost) ?? rp.position); _hitPos.y += 1; st.beamTo.copy(_hitPos);}
    } else {
      const o = cam.position;
      const d = cam.getWorldDirection(new THREE.Vector3());
      st.beamTo.copy(o).addScaledVector(d, hit.hitT);
    }
    st.beam.fire(_muzzle, st.beamTo, cam.position, hit.hitId !== null, hit.hitId !== null);
  }

  function tickBeam(dt: number): void {
    if (!st.beam) {return;}
    st.beam.update(dt);
    if (st.lastFire > 0 && performance.now() - st.lastFire > 90) {st.lastFire = 0;}
  }

  return { heal, updateBeamVisual, tickBeam };
}
