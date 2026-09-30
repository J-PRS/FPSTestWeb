// Server-authoritative projectile lifecycle — remote spawns/destroys and
// the pending-link handshake for our own shots.

import * as THREE from 'three';
import * as sfx from '../../core/sfx.js';
import { Projectile } from '../../projectiles/Projectile.js';
import { ROCKET_CONFIG, getProjectileConfig } from '../../projectiles/index.js';
import { WeaponType, getWeaponStats } from '../../../../shared/weapons.js';
import { Explosion } from '../../effects/explosion.js';
import { MELEE_RANGE, ROCKET_RADIUS } from '../../core/config.js';
import type { NetCtx } from './ctx.js';

export function wireProjectiles(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;

  const remoteProjectiles = new Map<string, Projectile>();

  // Melee swings carry a fake velocity (it's a swing marker, not a shell)
  // — painting the generic projectile would fly a rocket out of a fist.
  const meleeFlash = (origin: THREE.Vector3, dirV: THREE.Vector3): void => {
    const hit = origin.clone().addScaledVector(dirV.normalize(), MELEE_RANGE * 0.7);
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), hit, true, 0, deps.lazyTerrain(),
      (getWeaponStats(WeaponType.Melee).aoeRadius * 0.7) / ROCKET_RADIUS, 0xaaddff, 'punch',
    ));
  };

  networkManager.onProjectileCreated = (projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number) => {
    if (deps.world.playbackMode) return; // live shots don't belong in the replay
    // For own projectiles: link the pending local projectile to this server ID
    if (ownerId === nm().getLocalPlayerId()) {
      const localProjectile = deps.world.projectileRegistry.pending.shift();
      if (localProjectile) {
        localProjectile.serverProjectileId = projectileId;
        deps.world.projectileRegistry.byId.set(projectileId, localProjectile);
        deps.world.projectileRegistry.pendingSince.delete(localProjectile); // Clean up timestamp
      }
      return;
    }

    const vel = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const dir = vel.clone().normalize();
    if (weaponType === WeaponType.Melee) {
      meleeFlash(origin, dir);
      deps.world.remotePlayers.get(ownerId)?.fire(weaponType);
      sfx.shotAt(origin, WeaponType.Melee, deps.world.remotePlayers.get(ownerId)?.vel);
      return;
    }
    const cfg = (weaponType !== undefined ? getProjectileConfig(weaponType) : undefined) ?? ROCKET_CONFIG;
    const remoteProjectile = new Projectile(deps.lazyScene(), origin, dir, new THREE.Vector3(0, 0, 0), cfg);
    remoteProjectile.vel.copy(vel); // override with exact server velocity
    remoteProjectile.isRemote = true;
    // Ray-burst replicas discharge deterministically (delay/dir/range are
    // spawn-derived) — hook the beam flash so observers see the rail too.
    if (cfg.rayBurst) {
      const beamColor = cfg.glowColor;
      remoteProjectile.onRayBurst = (from, to) => {
        deps.lazyEffects().spawnBeam(from, to, beamColor);
        sfx.at(from, 'shot_energy', 0.9, 1.3);
      };
    }
    remoteProjectile.spawnedThisFrame = false; // remote projectiles don't need first-frame skip
    const shooterVel = deps.world.remotePlayers.get(ownerId)?.vel;
    // Fast-forward by half-RTT: the server relays the spawn ~half a round-trip
    // late, so without this the projectile lags behind the shooter's real one
    const lead = Math.min(0.15, nm().getPing() / 2000);
    if (lead > 0) {
      remoteProjectile.advanceBy(lead);
    }
    deps.world.projectiles.push(remoteProjectile);
    remoteProjectiles.set(projectileId, remoteProjectile);
    // Gun recoil kick on the shooter's remote model
    deps.world.remotePlayers.get(ownerId)?.fire(weaponType);
    sfx.shotAt(origin, cfg.weaponType, shooterVel);
  };

  // Hitscan fire relay — observers get muzzle audio at the shooter's
  // server-stamped position plus a recoil kick on the remote model; beams
  // also paint a short tracer along the claimed aim dir.
  networkManager.onPlayerShot = (id, weaponType, pos, dir) => {
    if (deps.world.playbackMode) return;
    const rp = deps.world.remotePlayers.get(id);
    const origin = pos
      ? new THREE.Vector3(pos.x, pos.y, pos.z)
      : rp?.position;
    if (!origin) return;
    rp?.fire(weaponType);
    sfx.shotAt(origin, weaponType ?? 0, rp?.vel);
    // The LG beam is instant on the shooter's screen — paint the same
    // flash for observers along the claimed aim (clamped, cosmetic-only).
    if (dir && weaponType === WeaponType.Lightning) {
      const cfg = getProjectileConfig(WeaponType.Lightning);
      const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
      deps.lazyEffects().spawnBeam(origin, origin.clone().addScaledVector(d, 80), cfg?.glowColor ?? 0x8fdcff);
    }
    // Melee swing — same small impact flash the puncher sees at the
    // reach point, so observers read the whiff, not just hear a whoosh.
    if (dir && weaponType === WeaponType.Melee) {
      meleeFlash(origin, new THREE.Vector3(dir.x, dir.y, dir.z));
    }
  };

  networkManager.onProjectileDestroyed = (projectileId: string) => {
    if (deps.world.playbackMode) return;
    // Kill remote projectile (explode so trail particles fade out naturally).
    // Delete the map entry now — the visual fade lives on world.projectiles,
    // not this map; keeping dead entries leaks one record per shot ever fired.
    const remoteProjectile = remoteProjectiles.get(projectileId);
    if (remoteProjectile) {
      remoteProjectile.explode();
      remoteProjectiles.delete(projectileId);
    }
    // Kill local projectile if server says it's gone - explode to let trails fade
    const localProjectile = deps.world.projectileRegistry.byId.get(projectileId);
    if (localProjectile) {
      localProjectile.explode();
      deps.world.projectileRegistry.byId.delete(projectileId);
      // Also remove from pending queue if it's still there (shouldn't happen but defensive)
      const pendingIndex = deps.world.projectileRegistry.pending.indexOf(localProjectile);
      if (pendingIndex !== -1) {
        deps.world.projectileRegistry.pending.splice(pendingIndex, 1);
        deps.world.projectileRegistry.pendingSince.delete(localProjectile);
      }
    }
  };
}
