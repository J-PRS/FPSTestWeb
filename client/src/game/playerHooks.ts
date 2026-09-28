// Every player.on* hook assignment — combat routes and the FX/sfx side
// effects for movement skills. Kept out of main.ts so the composition root
// reads as construction order, not a wall of lambdas.
import * as THREE from 'three';
import { Player } from '../entities/Player.js';
import { weaponDef } from '../weapons.js';
import type { createCombat } from './combat.js';
import type { EffectsManager } from '../effects/effects.js';
import type { ViewModel } from '../entities/ViewModel.js';
import type { SpeedLines } from '../effects/speedLines.js';
import * as sfx from '../core/sfx.js';
import { screenShake } from '../effects/screenShake.js';

const _blinkDir = new THREE.Vector3(); // scratch for the blink FX handler

export interface PlayerHookCtx {
  player: Player;
  combat: ReturnType<typeof createCombat>;
  effects: EffectsManager;
  viewModel: ViewModel | undefined;
  speedLines: SpeedLines;
}

export function wirePlayerHooks(c: PlayerHookCtx): void {
  const { player, combat, effects, viewModel, speedLines } = c;
  player.onWeaponFire = combat.onWeaponFire;
  player.onBelt = combat.onBelt;
  player.onWarpThrow = (pos) => { effects.spawnImpact(pos, player.vel); sfx.warpThrow(); };
  player.onWarpTick = (pos) => effects.spawnWarpTrail(pos); // spark trail ON the beacon
  player.onWarp = (from, to) => {
  // Two-stage pop: a collapse burst where you left, a bigger discharge
  // where you arrive — the arrival is the anchor point, it gets more.
  effects.spawnBounce(from, player.vel);
  effects.spawnImpact(from, player.vel);
  effects.spawnBounce(to, player.vel);
  effects.spawnImpact(to, player.vel);
  effects.spawnJetpack(to); // extra sparks at the landing anchor
  screenShake.blast(to, 2.2, player.pos);
  sfx.warpJump(to);
  };
  player.onMelee = combat.onMelee;
  player.onWeaponSwitch = (i) => { viewModel?.switchWeapon(weaponDef(i).weaponType); sfx.equip(); };
  player.onJump = (pos) => { effects.spawnJumpDust(pos); sfx.jump(); };
  player.onLand = (impactSpeed) => sfx.land(impactSpeed);
  player.onJetpack = (pos) => effects.spawnJetpack(pos);
  player.onSki = (pos, vel) => effects.spawnSkiDust(pos, vel);
  // Footstep dust — small radius (feet), speed drives the puff size so a
  // sprint kicks visibly more than a stroll
  player.onFootDust = (pos, vel) => effects.spawnMoveDust(pos, vel, Math.hypot(vel.x, vel.z), 0.5);
  player.onBounce = (pos, dir) => { effects.spawnBounce(pos, dir); viewModel?.kick(0.5); speedLines.burst(); sfx.bounce(); };
  player.onBlink = (from, to) => {
  // Tracer-style whoosh — cyan streaks stamped along the blink path
  speedLines.surge(from, to, 0x55ccff);
  viewModel?.kick(0.35);
  // Cyan flash at both ends — departure pop + arrival streak along the path
  _blinkDir.subVectors(to, from).normalize();
  effects.spawnBounce(from, _blinkDir);
  effects.spawnBounce(to, _blinkDir);
  sfx.blink();
  };
  player.onDash = (pos, dir) => {
  // White-hot streak line along the dash — reads as a boost, not a redirect
  // (bounce's cyan cone is the redirect cue; dash shares no shape language)
  _blinkDir.copy(dir).multiplyScalar(7).add(pos);
  speedLines.surge(pos, _blinkDir, 0xfff2cc, 10);
  effects.spawnJumpDust(pos);
  viewModel?.kick(0.4);
  sfx.dash();
  };
  player.onSlam = (pos, impactSpeed) => {
  combat.slam(pos, impactSpeed);
  speedLines.burst();
  viewModel?.kick(0.8);
  effects.spawnJumpDust(pos);
  sfx.slam();
  };}
