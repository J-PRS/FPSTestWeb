import * as THREE from 'three';

import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import { HEALBEAM_RANGE, HEALBEAM_PER_TICK, HEALBEAM_ENERGY, HEALBEAM_DETACH, HEALBEAM_HOLD_COS2, WeaponType } from '../../../../shared/weapons.js';
import { lgTrace, _lgHit } from './lightningTrace.js';
import { classCapsule } from '../../../../shared/botClasses.js';
import type { CombatDeps } from '../combat.js';
import type { FireEvent } from '../../entities/Player.js';

// Heal beam — the medic's pocket beam. Same honest ray as the LG
// (lgTrace already marches terrain, clips solids, and capsule-tests
// remote players): if the earliest contact is a teammate, the server
// pays HEALBEAM_PER_TICK off the same shotFired intent — the claim
// carries no amount and no target, so the client's beam, numbers, and
// energy drain are all prediction the wire echo lands.
//
// The ammo is jet energy - 10/s drain vs 8/s regen, a full tank is ~30s
// of beam (HEALBEAM_ENERGY/tick).

const _muzzle = new THREE.Vector3();
const _hitPos = new THREE.Vector3();
const _ghost = new THREE.Vector3();
const _lgT = { t: 0 };

interface HealState {
  beam: LightningBeam | null;
  lastFire: number;
  beamTo: THREE.Vector3;
  bend: THREE.Vector3;
  latched: boolean;
  latchId: string | null;
}

export function createHealBeam(deps: CombatDeps) {
  const st: HealState = { beam: null, lastFire: 0, beamTo: new THREE.Vector3(), bend: new THREE.Vector3(), latched: false, latchId: null };

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
    // Hysteresis (server mirrors in healBeamIntent): the latched
    // patient holds at the wider DETACH pad - only a wider miss lets a
    // fresh SNAP trace run, so edge-hovering can't flip-flop the beam.
    if (st.latchId) {
      const res = lgTrace(deps, cam, _lgT, HEALBEAM_RANGE, false, true, HEALBEAM_DETACH, HEALBEAM_HOLD_COS2);
      if (res.hitPlayerId === st.latchId) {return { hitId: st.latchId, hitT: res.hitT };}
      st.latchId = null;
    }
    // includeTeammates: the paid contact IS a friendly body - without it
    // the ray skips teammates entirely and the beam can never latch.
    const res = lgTrace(deps, cam, _lgT, HEALBEAM_RANGE, false, true);
    if (!res.hitPlayerId) {return { hitId: null, hitT: res.hitT };}
    const rp = deps.world.remotePlayers.get(res.hitPlayerId);
    const nm = deps.lazyNetworkManager?.();
    const team = (rp as { team?: string } | undefined)?.team ?? nm?.getPlayers().get(res.hitPlayerId)?.team;
    const friendly = team !== undefined && team === deps.world.localTeam;
    if (friendly) {st.latchId = res.hitPlayerId;}
    return { hitId: friendly ? res.hitPlayerId : null, hitT: res.hitT };
  }

  function heal(e: FireEvent): void {
    const p = deps.lazyPlayer();
    // Dry tank refuses the tick — the server gates on the same tank;
    // refusing here keeps the beam honest before the echo lands.
    if (p.energy < HEALBEAM_ENERGY) {return;}
    const cam = deps.lazyCamera();
    if (!st.beam) {
      st.beam = new LightningBeam(deps.lazyScene(), {
        // Medic gold - reads "heal" at a glance, and collides with
        // nothing else in the arsenal (repair owns weld-green).
        glow: 0xE8_A0_20, core: 0xFF_F4_D8, chain: 0xFF_D0_70, hit: 0xFF_DE_88, sparkTop: 0xFF_B8_40,
      });
    }
    st.lastFire = performance.now();
    const hit = traceHeal(cam);
    if (hit.hitId) {
      // Mercy curve: quadratic-bezier control point on the aim line at
      // the ray's contact - the beam leaves the muzzle along your aim,
      // then arcs smoothly onto the patient's capsule center.
      const rp = deps.world.remotePlayers.get(hit.hitId);
      _hitPos.copy(rp?.position ?? _lgHit);
      _hitPos.y += rp ? classCapsule(rp.armorClass).centerOff : 0;
      deps.lazyDamageNumbers().spawn(_hitPos, HEALBEAM_PER_TICK, '#ffde88', cam);
      st.beamTo.copy(_hitPos);
      st.bend.copy(_lgHit);
      // No server authority (offline/P2P): the client owns the patient's
      // pool - GameBot.heal is the local-authority mirror of the
      // server's healBeamTick, same tick amount.
      if (!deps.lazyNetworkManager()?.authoritySims()) {(rp as { heal?: (n: number) => void } | undefined)?.heal?.(HEALBEAM_PER_TICK);}
    } else {
      const o = cam.position;
      const d = cam.getWorldDirection(new THREE.Vector3());
      st.beamTo.copy(o).addScaledVector(d, hit.hitT);
    }
    st.latched = hit.hitId !== null;
    // Predicted tank drain - the server only pays the tick on a real
    // patient contact, so whiffs drain nothing; drain only on hitId or
    // the echo snaps the tank back up every miss.
    if (hit.hitId) {p.energy = Math.max(0, p.energy - HEALBEAM_ENERGY);}
    muzzle(cam);
    st.beam.fire(_muzzle, st.beamTo, cam.position, hit.hitId !== null, hit.hitId !== null, null, hit.hitId ? st.bend : null);
  }

  function updateBeamVisual(): void {
    if (!st.beam || st.lastFire <= 0) {return;}
    const cam = deps.lazyCamera();
    muzzle(cam);
    if (performance.now() - st.lastFire > 90) {
      // Released: the bolt is fading - weld it like the LG or the muzzle
      // end freezes mid-air while the viewmodel/camera moves on.
      if (st.beam.visible) {st.beam.weld(_muzzle, st.beamTo, cam.position, null, st.latched ? st.bend : null);}
      return;
    }
    const hit = traceHeal(cam);
    if (hit.hitId) {
      const rp = deps.world.remotePlayers.get(hit.hitId);
      st.beamTo.copy(rp?.position ?? _lgHit);
      if (rp) {st.beamTo.y += classCapsule(rp.armorClass).centerOff;}
      st.bend.copy(_lgHit);
    }
    st.latched = hit.hitId !== null;
    if (!hit.hitId) {
      const o = cam.position;
      const d = cam.getWorldDirection(new THREE.Vector3());
      st.beamTo.copy(o).addScaledVector(d, hit.hitT);
    }
    st.beam.fire(_muzzle, st.beamTo, cam.position, hit.hitId !== null, hit.hitId !== null, null, hit.hitId ? st.bend : null);
  }

  function tickBeam(dt: number): void {
    if (!st.beam) {return;}
    st.beam.update(dt);
    if (st.lastFire > 0 && !st.beam.visible) {st.lastFire = 0;}
  }

  return { heal, updateBeamVisual, tickBeam };
}
