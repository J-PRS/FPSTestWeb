// Server-authoritative projectile lifecycle — remote spawns/destroys and
// the pending-link handshake for our own shots.

import * as THREE from 'three';
import * as sfx from '../../core/sfx.js';
import { Projectile } from '../../projectiles/Projectile.js';
import { ROCKET_CONFIG, getProjectileConfig } from '../../projectiles/index.js';
import type { NetCtx } from './ctx.js';

export function wireProjectiles(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;

  const remoteProjectiles = new Map<string, Projectile>();

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
    // Fast-forward by half-RTT: the server relays the spawn ~half a round-trip
    // late, so without this the projectile lags behind the shooter's real one
    const lead = Math.min(0.15, nm().getPing() / 2000);
    if (lead > 0) {
      remoteProjectile.advanceBy(lead);
    }
    deps.world.projectiles.push(remoteProjectile);
    remoteProjectiles.set(projectileId, remoteProjectile);
    // Gun recoil kick on the shooter's remote model
    deps.world.remotePlayers.get(ownerId)?.fire();
    sfx.shotAt(origin, cfg.weaponType);
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
