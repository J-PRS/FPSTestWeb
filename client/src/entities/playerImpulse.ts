import * as THREE from 'three';
import { weaponDef } from '../weapons.js';
import { DISC_RATE } from '../core/config.js';
import { THROW_TOTAL } from './ViewModel.js';
import { CLASS_STATS } from '../../../shared/botClasses.js';
import type { Player } from './Player.js';

// Trigger + impulse family: weapon/belt fire intent and every
// pos/vel writer that must sync back into the movement controller.

  // Weapon triggers: selected weapon (LMB) plus C/F belt throws.
export function fireWeapons(p: Player): void {
    const wid = p.armory.secondaryWid ?? p.loadout[p.weaponIndex];
    const def = weaponDef(wid);
    // Weapon is lowered during a belt-throw — no primary fire mid-throw.
    // A held secondary auto-fires at its own cadence — no click needed.
    const wantFire = p.throwLockT <= 0 &&
      (p.armory.secondaryWid !== null ? p.armory.secondaryDrawT <= 0
        : def.auto ? p.input.mouseHeld : (p.input.firePending || (p.input.mouseHeld && !p.input.needsRelease)));
    if (!p.input.mouseHeld) p.input.needsRelease = false;
    if (wantFire && p.fireTimer <= 0) {
      p.fireTimer = def.rate;
      p.shootAnimTimer = 0.3;
      p.onWeaponFire?.(def, { origin: p.pos.clone(), dir: p.getAimDir(), playerVel: p.vel.clone() });
    }
    p.input.firePending = false;

    // Belt item (C key) — the equipped throw; hold to repeat
    if (p.input.beltHeld && p.beltTimer <= 0) {
      p.beltTimer = DISC_RATE;
      p.throwLockT = THROW_TOTAL;
      p.shootAnimTimer = 0.3; // lob raise — same snap as a shot
      p.model?.weaponThrow();
      p.onBelt?.({ origin: p.pos.clone(), dir: p.getAimDir(), playerVel: p.vel.clone() }, p.beltItem);
    }
  }

  /** Nugget pickup: half the tank back, no free-jet window — unlimited
   *  energy made the toggle skills (cloak/shield/mend) effectively free. */
export function grantJetBoost(p: Player): void {
    p.energy = Math.min(p.energyCap, p.energy + p.energyCap * 0.5);
  }

  /** Nugget pickup: restore a chunk of health, capped at max. */
export function heal(p: Player, fraction: number): void {
    p.health = Math.min(p.maxHealth, p.health + p.maxHealth * fraction);
  }

export function applyKnockback(p: Player, from: THREE.Vector3, force: number): void {
    // Force arrives pre-mass (server sends the raw impulse magnitude and
    // scales its own dv by class mass) — divide here so the predicted and
    // wire echoes land the same delta.
    const f = force / CLASS_STATS[p.appliedClass].mass;
    const dir = p.pos.clone().sub(from).normalize();
    p.vel.addScaledVector(dir, f);
    p.vel.y += f * 0.5;
    // Explosion impulse ungrounds — otherwise ground friction eats the
    // horizontal component while still within the near-ground band.
    p.onGround = false;
    p.syncMovement();
  }

export function applyPull(p: Player, to: THREE.Vector3, force: number): void {
    const f = force / CLASS_STATS[p.appliedClass].mass;
    const dir = to.clone().sub(p.pos).normalize();
    p.vel.addScaledVector(dir, f);
    p.vel.y += f * 0.3;
    p.onGround = false;
    p.syncMovement();
  }

