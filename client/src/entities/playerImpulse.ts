import type * as THREE from 'three';
import { weaponDef } from '../weapons.js';
import { DISC_RATE } from '../core/config.js';
import { THROW_TOTAL } from './ViewModel.js';
import { CLASS_STATS } from '../../../shared/botClasses.js';
import type { Player } from './Player.js';
import { PlayerLoadout } from './playerLoadout.js';
import { ChildLogger } from '../core/Logger.js';
import { inv } from '../../../shared/invariants.js';
import { finiteVec } from '../../../shared/wire.js';
import { ammoOf } from '../../../shared/weapons.js';

// Trigger + impulse family: weapon/belt fire intent and every
// pos/vel writer that must sync back into the movement controller.
const logger = new ChildLogger('Impulse');

  /** Primary-fire intent: weapon lowered during a belt-throw, a held
   *  secondary auto-fires at its own cadence, and class-locked ordnance
   *  in a stale/banked slot never predicts a shot — the menu greys it
   *  and the server rejects every claim (same gate, appliedClass). */
function wantFireWeapon(p: Player, wid: number, auto: boolean): boolean {
    if (p.throwLockT > 0 || PlayerLoadout.lockedForClass(p.appliedClass, wid)) {return false;}
    // Swap draw lock - the gun is still coming up; taps ride firePending
    // (kept below) so a press mid-draw fires the moment it's out.
    if (p.weaponDrawT > 0) {return false;}
    // Pool ammo (PlasmaGun pilot): a dry pool doesn't burn fireTimer or
    // play the anim - the next tick re-tries, so the trickle regen IS
    // the sustained cadence once the clip drains. fire.ts does the spend.
    // wid is a loadout SLOT index - the pool keys on the real weaponType.
    if ((ammoOf(p.ammoPool, weaponDef(wid).weaponType, performance.now() / 1000) ?? 1) < 1) {return false;}
    if (p.armory.secondaryWid !== null) {return p.armory.secondaryDrawT <= 0;}
    return auto ? p.input.mouseHeld : (p.input.firePending || (p.input.mouseHeld && !p.input.needsRelease));
  }

  /** A class-locked pick can't fire — same gate the server enforces. If
   *  one still sits equipped (stale banked loadout, console edit), the
   *  first trigger pull silently unshoulders it to the chaingun — every
   *  class shoulders it — and the pull falls through to the swapped gun. */
function unshoulderOnPull(p: Player, wid: number): number {
    if (p.armory.secondaryWid !== null
        || !PlayerLoadout.lockedForClass(p.appliedClass, wid)) {return wid;}
    p.setLoadoutSlot(p.weaponIndex, PlayerLoadout.fallbackWid(p.appliedClass, p.loadout));
    return p.loadout[p.weaponIndex];
  }

  /** Can a belt throw fire now? Paces on BOTH the 1s belt cadence and the
   *  throw lock — a stretched throw (satchel ≈ 1.9s) outlasts the cadence,
   *  so pacing on the cadence alone let a second throw start inside the
   *  first's wind-up (and its press-gate saw the unspent charges). */
export function beltThrowReady(beltTimer: number, throwLockT: number): boolean {
    return beltTimer <= 0 && throwLockT <= 0;
  }

  // Weapon triggers: selected weapon (LMB) plus C/F belt throws.
export function fireWeapons(p: Player): void {
    // Dead men don't fire — there was no gate here (belt releases already
    // guard isDead), so holding the trigger through a death spammed
    // shotFired intents the server rejects as 'Shot: shooter dead'.
    if (p.isDead) { p.input.firePending = false; return; }
    let wid = p.armory.secondaryWid ?? p.loadout[p.weaponIndex];
    wid = unshoulderOnPull(p, wid);
    const def = weaponDef(wid);
    const wantFire = wantFireWeapon(p, wid, def.auto);
    if (!p.input.mouseHeld) {p.input.needsRelease = false;}
    if (wantFire && p.fireTimer <= 0) {
      p.fireTimer = def.rate;
      p.shootAnimTimer = 0.3;
      p.onWeaponFire?.(def, { origin: p.pos.clone(), dir: p.getAimDir(), playerVel: p.vel.clone() });
    }
    if (p.weaponDrawT <= 0) {p.input.firePending = false;}

    // Belt item (C key) — the equipped throw; hold to repeat. The throw
    // lock gates too: a stretched throw (satchel ≈ 1.9s) outlasts the 1s
    // belt cadence, and pacing on beltTimer alone let a second throw start
    // inside the first's wind-up. Charges gate the wind-up too — onBelt
    // re-checks before release, but a dry press still played the full
    // swing + lock. Satchel is the only multi-charge item
    // (beltThrowCost, shared/weapons).
    const beltCost = p.beltItem === 'satchel' ? 2 : 1;
    if (p.input.beltHeld && p.beltCharges >= beltCost && beltThrowReady(p.beltTimer, p.throwLockT)) {
      p.beltTimer = DISC_RATE;
      // BELT_THROW_TIME lives in Player.ts (canonical, used by fire.ts too);
// inlined here to break the Player <-> playerImpulse cycle (Player imports
// playerImpulse as `imp` for method delegation). Keep in sync if the
// satchel stretch changes.
p.throwLockT = THROW_TOTAL * (p.beltItem === 'satchel' ? 1.9 : 1);
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
    if (!Number.isFinite(f) || !finiteVec(from)) { inv('impulse-finite', false, { force, from }); return; }
    logger.info('impulse: knockback', { force: Number(f.toFixed(1)), from: { x: Number(from.x.toFixed(1)), y: Number(from.y.toFixed(1)), z: Number(from.z.toFixed(1)) }, velY: Number(p.vel.y.toFixed(1)) });
    const dir = p.pos.clone().sub(from).normalize();
    p.vel.addScaledVector(dir, f);
    p.vel.y += f * 0.5;
    // Explosion impulse ungrounds — otherwise ground friction eats the
    // horizontal component while still within the near-ground band.
    p.onGround = false;
    p.syncMovement();
  }

export function applyPull(p: Player, to: THREE.Vector3, force: number, yank = false): void {
    const f = force / CLASS_STATS[p.appliedClass].mass;
    if (!Number.isFinite(f) || !finiteVec(to)) { inv('impulse-finite', false, { force, to }); return; }
    logger.info('impulse: pull', { force: Number(f.toFixed(1)), to: { x: Number(to.x.toFixed(1)), y: Number(to.y.toFixed(1)), z: Number(to.z.toFixed(1)) }, velY: Number(p.vel.y.toFixed(1)) });
    const dir = to.clone().sub(p.pos).normalize();
    p.vel.addScaledVector(dir, f);
    // Disc-suck pulls pop +0.3 up off the horizontal; a rope dart flies
    // AT the anchor — its y already lives inside dir, pop would overshoot.
    if (!yank) {p.vel.y += f * 0.3;}
    p.onGround = false;
    p.syncMovement();
  }

