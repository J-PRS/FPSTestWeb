// Every player.on* hook assignment — combat routes and the FX/sfx side
// effects for movement skills. Kept out of main.ts so the composition root
// reads as construction order, not a wall of lambdas.
import * as THREE from 'three';
import type { Player } from '../entities/Player.js';
import { weaponDef } from '../weapons.js';
import type { createCombat } from './combat.js';
import type { EffectsManager } from '../effects/effects.js';
import type { ViewModel } from '../entities/ViewModel.js';
import type { SpeedLines } from '../effects/speedLines.js';
import { Implosion } from '../effects/implosion.js';
import { Explosion } from '../effects/explosion.js';
import { EXPLOSION_VFX_RADIUS } from '../core/config.js';
import type { WorldState } from './worldState.js';
import type { Terrain } from '../world/terrain.js';
import * as sfx from '../core/sfx.js';
import { screenShake } from '../effects/screenShake.js';

const _blinkDir = new THREE.Vector3(); // scratch for the blink FX handler

export interface PlayerHookCtx {
  player: Player;
  combat: ReturnType<typeof createCombat>;
  effects: EffectsManager;
  viewModel: ViewModel | undefined;
  speedLines: SpeedLines;
  world: WorldState;
  scene: THREE.Scene;
  terrain: Terrain;
  /** Held-weapon wire edge (roster `weapon`) - remotes draw the real
   *  gun instead of the stock prop. */
  sendHeld: (wt: number) => void;
}

export function wirePlayerHooks(c: PlayerHookCtx): void {
  const { player, combat, effects, viewModel, speedLines, world, scene, terrain } = c;
  player.onWeaponFire = combat.onWeaponFire;
  player.onBelt = combat.onBelt;
  player.onWarpThrow = (pos): void => { effects.spawnImpact(pos, player.vel); sfx.warpThrow(); };
  player.onWarpTick = (pos): void => effects.spawnWarpTrail(pos); // spark trail ON the beacon
  player.onWarp = (from, to): void => {
  // Warp sell, in three beats:
  //  1. DEPARTURE implosion — the space you vacated caves inward (the
  //     collapse reads as "torn out of the world", not "moved").
  //  2. CONDUIT beam + dense streak corridor along the path — the eye
  //     needs to see WHERE you went or the teleport reads as a cut.
  //  3. ARRIVAL discharge — a real blast at the landing anchor; it owns
  //     the bigger share of the FX budget.
  world.implosions.push(new Implosion(scene, from, 0, terrain));
  effects.spawnBeam(from, to, 0x55_FF_DD);
  speedLines.surge(from, to, 0x33_FF_DD, 22);
  world.explosions.push(new Explosion(
    scene, to, true, 0, terrain, 5.5 / EXPLOSION_VFX_RADIUS, 0x66_FF_EE, 'punch',
  ));
  effects.spawnBounce(to, player.vel);
  effects.spawnJetpack(to); // extra sparks at the landing anchor
  screenShake.blast(to, 5.5, player.pos);
  screenShake.add(0.3);
  sfx.warpJump(to);
  };
  player.onMelee = combat.onMelee;
  player.onWeaponSwitch = (i): void => { const wt = weaponDef(i).weaponType; viewModel?.switchWeapon(wt); sfx.equip(); c.sendHeld(wt); };
  player.onJump = (pos): void => { effects.spawnJumpDust(pos); sfx.jump(); };
  player.onLand = (impactSpeed): void => sfx.land(impactSpeed);
  player.onJetpack = (pos): void => effects.spawnJetpack(pos);
  player.onSki = (pos, vel): void => effects.spawnSkiDust(pos, vel);
  // Footstep dust — small radius (feet), speed drives the puff size so a
  // sprint kicks visibly more than a stroll
  player.onFootDust = (pos, vel): void => effects.spawnMoveDust(pos, vel, Math.hypot(vel.x, vel.z), 0.5);
  player.onBounce = (pos, dir): void => { effects.spawnBounce(pos, dir); speedLines.burst(); sfx.bounce(); };
  player.onBlink = (from, to): void => {
  // Tracer-style whoosh — cyan streaks stamped along the blink path
  speedLines.surge(from, to, 0x55_CC_FF);
  // Cyan flash at both ends — departure pop + arrival streak along the path.
  // A blocked warp can land on its origin: normalize of a zero vector is NaN.
  _blinkDir.subVectors(to, from);
  if (_blinkDir.lengthSq() > 1e-6) {_blinkDir.normalize();} else {_blinkDir.set(0, 1, 0);}
  effects.spawnBounce(from, _blinkDir);
  effects.spawnBounce(to, _blinkDir);
  sfx.blink();
  };
  player.onDash = (pos, dir): void => {
  // White-hot streak line along the dash — reads as a boost, not a redirect
  // (bounce's cyan cone is the redirect cue; dash shares no shape language)
  _blinkDir.copy(dir).multiplyScalar(7).add(pos);
  speedLines.surge(pos, _blinkDir, 0xFF_F2_CC, 10);
  effects.spawnJumpDust(pos);
  sfx.dash();
  };
  player.onSlam = (pos, impactSpeed): void => {
  combat.slam(pos, impactSpeed);
  speedLines.burst();
  effects.spawnJumpDust(pos);
  sfx.slam();
  };}
