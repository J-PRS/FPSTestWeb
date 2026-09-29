// Blast force application: push/pull on the local player, creatures,
// nuggets, and remote players — plus splash damage numbers/health bars.
// Extracted from combat.ts; the explosion VFX path stays there.

import * as THREE from 'three';

import { getProjectileConfig } from '../projectiles/index.js';
import { Projectile } from '../projectiles/Projectile.js';
import { aoeImpulse, aoeDamage as aoeDamageOf, KNOCKBACK_SCALE } from '../../../shared/combat.js';
import { blastOccluded } from '../../../shared/solidWorld.js';
import type { CombatDeps } from './combat.js';
import type { Targetable } from '../entities/balls.js';
import * as sfx from '../core/sfx.js';

export interface BlastForceHooks {
  onTargetDestroyed(t: Targetable, impulse?: THREE.Vector3, weaponType?: number): void;
}

interface Forceable {
  pos: THREE.Vector3;
  applyKnockback(from: THREE.Vector3, force: number): void;
  applyPull(to: THREE.Vector3, force: number): void;
}

// Self-inflicted splash is nominal — enough to feel the blast on a
// rocket jump without it eating your health bar
const SELF_AOE_DAMAGE_SCALE = 0.15;

export function createBlastForce(deps: CombatDeps, hooks: BlastForceHooks) {
  // Same LOS rule the server applies: a wall between blast and target
  // swallows the prediction — keeps the client from flashing knockback/
  // damage the funnel will never confirm (then resyncing it back).
  const solids = () => Projectile.solidColliders;
  const occluded = (pos: THREE.Vector3, target: THREE.Vector3) =>
    solids().length > 0 && blastOccluded(pos, target, solids());

  // Splash damage-number color follows the weapon — getProjectileConfig
  // looks up by wire weaponType (the array order isn't the enum).
  function splashColor(weaponType?: number): string {
    return getProjectileConfig(weaponType ?? 0)?.damageColor ?? '#ffcc66';
  }

  // Nuggets are light pickups — blast throws them at a boosted force so
  // explosions visibly scatter loot instead of it hovering through the blast
  function applyForceToNuggets(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    forceMultiplier: number
  ): void {
    const f = force * forceMultiplier * 1.3;
    for (const n of deps.nuggets) {
      if (n.dead || n.collected) continue;
      if (n.pos.distanceToSquared(pos) < radius * radius) {
        if (forceMode === 'push') n.applyKnockback(pos, f);
        else n.applyPull(pos, f);
      }
    }
  }

  function applyForceToBalls(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    collisionMultiplier: number,
    forceMultiplier: number,
    aoeDamage: number,
    applyTo: (t: Forceable, f: number) => void,
    weaponType?: number
  ): void {
    for (const ball of deps.targets) {
      if (ball.dead) continue;
      const db = ball.pos.distanceTo(pos);
      const br = ball.hitRadius ?? ball.radius;
      const threshold = forceMode === 'push'
        ? radius + br
        : radius * collisionMultiplier + br;
      if (db < threshold && !occluded(pos, ball.pos)) {
        applyTo(ball, force * forceMultiplier);
        // Splash actually hurts enemies — falloff-scaled like players, with
        // the same damage number + health bar feedback as direct hits
        // (without it, splash damage was invisible and read as "no damage").
        const dmg = aoeDamageOf(aoeDamage, db, radius);
        if (dmg >= 1) {
          deps.lazyDamageNumbers().spawn(ball.pos, dmg, splashColor(weaponType), deps.lazyCamera());
          deps.reportTargetDamage?.(ball, dmg);
          if (ball.takeDamage(dmg)) hooks.onTargetDestroyed(ball, ball.vel, weaponType);
          else {
            if (!ball.hideHealthBar) deps.lazyHealthBarSystem().spawnBall(ball, dmg, ball.health);
            const dm = deps.lazyDemoManager();
            if (dm?.isRecording) {
              dm.recordTargetHit(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant, ball.health);
            }
          }
        }
      }
    }
  }

  // Remote players: damage preview + predicted knockback. Prediction mirrors
  // the server's impulse math (force * (1-dist/radius)) and only bridges the
  // ~1 RTT before the victim's real trajectory streams back — RemotePlayer
  // runs it as dead reckoning and clears stale pre-hit snapshots so there's
  // no snap-back when interpolation resumes.
  function applyForceToRemotes(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    aoeDamage: number,
    directHitTargetId: string | null
  ): void {
    for (const [playerId, rp] of deps.world.remotePlayers) {
      if (rp.isDead) continue;
      // Match server damage exactly: 1 - dist/radius inside radius, 0 outside.
      // (The wider falloffAt curve is for knockback reach only — using it here
      // predicts splash damage the server never applies, and the health bar
      // snaps back to full on the next authoritative update.)
      const dist = rp.position.distanceTo(pos);
      const impulse = aoeImpulse(force, dist, radius) * KNOCKBACK_SCALE;
      if (impulse <= 0) continue;
      if (occluded(pos, rp.position)) continue;
      rp.applyPredictedKnockback(pos, impulse, forceMode === 'pull');
      if (playerId === directHitTargetId) continue;
      deps.lazyHud().showHitMarker();
      const aoeDmg = aoeDamageOf(aoeDamage, dist, radius);
      if (deps.botHit?.(playerId, aoeDmg, pos)) continue; // local authority resolved it
      deps.lazyHealthBarSystem().predictDamage(playerId, aoeDmg);
    }
  }

  // Apply push/pull force to local player, balls, and remote players
  function applyExplosionForce(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    falloffMultiplier: number,
    collisionMultiplier: number,
    forceMultiplier: number,
    aoeDamage: number,
    directHitTargetId: string | null,
    weaponType?: number
  ): void {
    const falloffAt = (dist: number) => 1 - dist / (radius * falloffMultiplier);
    const applyTo = (t: Forceable, f: number) =>
      forceMode === 'push' ? t.applyKnockback(pos, f) : t.applyPull(pos, f);

    const player = deps.lazyPlayer();
    const dpx = player.pos.distanceTo(pos);
    if (dpx < radius * falloffMultiplier && !occluded(pos, player.pos)) {
      applyTo(player, force * KNOCKBACK_SCALE * falloffAt(dpx) * player.mods.knockbackTaken);
      // Stamp the prediction — the server echoes this same shove back as a
      // `knockback` message ~RTT later; net/players.ts consumes the stamp
      // so the blast can't land twice.
      const stamps = deps.world.selfBlastStamps;
      stamps.push({ x: pos.x, y: pos.y, z: pos.z, t: performance.now() });
      if (stamps.length > 8) stamps.shift();
      // Self-AOE damage: a tiny fraction of what an enemy would take at the
      // same distance — rocket jumps should be viable, not lethal. Faint
      // vignette only, no hurt sound (JP: the grunt is too much for this).
      const selfDmg = aoeDamageOf(aoeDamage, dpx, radius) * SELF_AOE_DAMAGE_SCALE;
      if (selfDmg >= 1 && !player.isDead) {
        // Shield soaks self-splash too — the server holds health steady so
        // the only thing to report is the energy burn + its flash.
        if (player.isShielded) {
          player.absorbShieldDamage(selfDmg);
          deps.lazyHud().showShieldDamage(null, selfDmg);
          sfx.shieldHit();
        } else {
          player.lastDamageSource = 'cooked by your own blast'; // suicide reads as suicide, not "a crawler"
          deps.lazyNetworkManager()?.sendEnvironmentDamage(selfDmg);
          deps.lazyHud().showDamage(null, selfDmg);
        }
      }
    }
    const kbForce = force * KNOCKBACK_SCALE;
    applyForceToBalls(pos, radius, kbForce, forceMode, collisionMultiplier, forceMultiplier, aoeDamage, applyTo, weaponType);
    applyForceToNuggets(pos, radius, kbForce, forceMode, forceMultiplier);
    applyForceToRemotes(pos, radius, force, forceMode, aoeDamage, directHitTargetId);
  }

  return { applyExplosionForce, applyForceToRemotes };
}
