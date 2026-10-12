// Server-authoritative projectile lifecycle — remote spawns/destroys and
// the pending-link handshake for our own shots.

import * as THREE from 'three';
import * as sfx from '../../core/sfx.js';
import { Projectile } from '../../projectiles/Projectile.js';
import { BOLT_CONFIG, getProjectileConfig } from '../../projectiles/index.js';
import { WeaponType, getWeaponStats } from '../../../../shared/weapons.js';
import { Explosion } from '../../effects/explosion.js';
import { swingSwipe } from '../../effects/swingTrails.js';
import { MELEE_RANGE, EXPLOSION_VFX_RADIUS } from '../../core/config.js';
import { noteShellFate } from '../parity.js';
import type { NetCtx } from './ctx.js';

/** Last weapon + shot count seen per shooter — every remote fire event
 *  funnels through here (botFire markers included), so alt+w can audit
 *  what each bot is actually drawing. */
export const lastWeaponByPlayer = new Map<string, { wt: number; n: number }>();
function noteWeapon(id: string, weaponType: number | undefined): void {
  if (weaponType === undefined) {return;}
  const rec = lastWeaponByPlayer.get(id) ?? { wt: 0, n: 0 };
  rec.wt = weaponType;rec.n += 1;
  lastWeaponByPlayer.set(id, rec);
}

export function wireProjectiles(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;

  const remoteProjectiles = new Map<string, Projectile>();

  // Melee swings carry a fake velocity (it's a swing marker, not a shell)
  // — painting the generic projectile would fly a rocket out of a fist.
  const meleeFlash = (origin: THREE.Vector3, dirV: THREE.Vector3): void => {
    const hit = origin.clone().addScaledVector(dirV.normalize(), MELEE_RANGE * 0.7);
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), hit, true, 0, deps.lazyTerrain(),
      (getWeaponStats(WeaponType.Melee).aoeRadius * 0.7) / EXPLOSION_VFX_RADIUS, 0xAA_DD_FF, 'punch',
    ));
    // Enemy swings get the slash arc too — the streak is what makes a
    // punch readable at range (there's no arm animation to read).
    swingSwipe(deps.lazyScene(), origin, dirV);
  };

  // Swing markers and beam-class weapon fire carry no projectile body —
  // the message is cosmetic, so paint the punch flash / instant shaft a
  // player's weld paints instead of flying a slow fake bolt. */
  const cosmeticShot = (ownerId: string, weaponType: number | undefined, origin: THREE.Vector3, dir: THREE.Vector3): boolean => {
    if (weaponType === WeaponType.Melee) {
      meleeFlash(origin, dir);
    } else if (weaponType !== undefined && getWeaponStats(weaponType).speed <= 0) {
      const beamCfg = getProjectileConfig(weaponType);
      deps.lazyEffects().spawnBeam(origin, origin.clone().addScaledVector(dir, 80), beamCfg?.glowColor ?? 0x8F_DC_FF);
    } else {
      return false;
    }
    deps.world.remotePlayers.get(ownerId)?.fire(weaponType);
    sfx.shotAt(origin, weaponType, deps.world.remotePlayers.get(ownerId)?.vel);
    return true;
  };

  // Bind a server id echo to the local shell that spawned it — the spawn
  // claim's shotId nonce comes back verbatim, so the link is exact (no
  // FIFO, no position inference, immune to rejected/dropped claims).
  const linkOwnProjectile = (projectileId: string, shotId?: string, pellet?: number): void => {
    const registry = deps.world.projectileRegistry;
    let localProjectile;
    if (shotId) {
      localProjectile = pellet === undefined ? registry.byShotId.get(shotId) : registry.byFanSlot.get(`${shotId}#${pellet}`);
    }
    if (!localProjectile) {
      // A missing entry after the nonce mint is either an echo that
      // outlived a fast-popping shell (nonce pruned at death — benign)
      // or a spawn that never sent shotId — a real wiring break.
      if (shotId === undefined) {
        deps.logger.warn(`[Net] projectileCreated ${projectileId} for an own shot carrying no shotId`);
      } else {
        deps.logger.debug(`[Net] projectileCreated ${projectileId} echo for a dead shell (shotId=${shotId})`);
      }
      return;
    }
    localProjectile.serverProjectileId = projectileId;
    registry.byId.set(projectileId, localProjectile);
    // Burst pellet binding is one-shot — the slot frees once linked.
    if (localProjectile.fanSlot) {
      registry.byFanSlot.delete(localProjectile.fanSlot);
      localProjectile.fanSlot = null;
    }
  };

  networkManager.onProjectileCreated = (projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number, shotId?: string, pellet?: number): void => {
    if (deps.world.playbackMode) {return;} // live shots don't belong in the replay
    noteWeapon(ownerId, weaponType);
    // For own projectiles: link the server id to the local shell by nonce.
    if (ownerId === nm().getLocalPlayerId()) {
      linkOwnProjectile(projectileId, shotId, pellet);
      return;
    }

    // NaN spawn vectors seed a NaN trajectory — and a NaN trail emitter
    // paints the whole sky. normalize() on a zero vector is NaN too.
    if (!Number.isFinite(position.x + position.y + position.z
        + velocity.x + velocity.y + velocity.z)) {return;}
    const vel = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const dir = vel.lengthSq() > 0 ? vel.clone().normalize() : new THREE.Vector3(0, 0, 1);
    if (cosmeticShot(ownerId, weaponType, origin, dir)) {return;}
    const cfg = (weaponType === undefined ? undefined : getProjectileConfig(weaponType)) ?? BOLT_CONFIG;
    const remoteProjectile = new Projectile(deps.lazyScene(), origin, dir, new THREE.Vector3(0, 0, 0), cfg);
    remoteProjectile.vel.copy(vel); // override with exact server velocity
    remoteProjectile.isRemote = true;
    // The shooter's rendered remote can sit a leash-width off the server's
    // spawn point — seed the render offset from the model we see so the
    // shell leaves that muzzle and blends onto the true trajectory instead
    // of popping in offset from the model while the flash plays on it.
    // Beyond ~10m the remote is mid-reseat anyway; a swooping shell reads
    // worse than the pop there.
    const rp = deps.world.remotePlayers.get(ownerId);
    if (rp) {
      remoteProjectile.renderOffset.copy(rp.position).sub(origin);
      if (remoteProjectile.renderOffset.lengthSq() > 100) {remoteProjectile.renderOffset.set(0, 0, 0);}
    }
    // Wire shells are NEVER "mine" — unset shooterId reads as local player
    // authorship in every feedback gate (hitmarker/numbers/self-splash
    // scale) and would even let a remote shell sendShot-claim its hits
    // under my id. Stamp the real owner.
    remoteProjectile.shooterId = ownerId;
    // Roster team — team-filtered solids (shield gates) pass an owner's
    // shell through when it matches, same as the server sim.
    remoteProjectile.shooterTeam = nm().getPlayers().get(ownerId)?.team ?? null;
    // Fuse jitter seeds from this id — the replica pops at the server's age.
    remoteProjectile.serverProjectileId = projectileId;
    // Ray-burst replicas discharge deterministically (delay/dir/range are
    // spawn-derived) — hook the beam flash so observers see the rail too.
    if (cfg.rayBurst) {
      const beamColor = cfg.glowColor;
      remoteProjectile.onRayBurst = (from, to): void => {
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
    // Wire destroy only covers server-simmed shells — claim-path replicas
    // die locally on fuse/terrain, so record the death wherever it happens
    // and release the map entry either way.
    remoteProjectile.onExploded = (): void => {
      deps.lazyDemoManager?.()?.recordRemoteProjectileDestroyed(projectileId, remoteProjectile.pos);
      remoteProjectiles.delete(projectileId);
    };
    deps.lazyDemoManager?.()?.recordRemoteProjectileFired(projectileId, position, velocity, weaponType ?? cfg.weaponType, ownerId);
    // Gun recoil kick on the shooter's remote model
    deps.world.remotePlayers.get(ownerId)?.fire(weaponType);
    sfx.shotAt(origin, cfg.weaponType, shooterVel);
  };

  // Hitscan fire relay — observers get muzzle audio at the shooter's
  // server-stamped position plus a recoil kick on the remote model; beams
  // also paint a short tracer along the claimed aim dir.
  networkManager.onPlayerShot = (id, weaponType, pos, dir): void => {
    if (deps.world.playbackMode) {return;}
    noteWeapon(id, weaponType);
    const rp = deps.world.remotePlayers.get(id);
    const origin = pos && Number.isFinite(pos.x + pos.y + pos.z)
      ? new THREE.Vector3(pos.x, pos.y, pos.z)
      : rp?.position;
    if (!origin) {return;}
    rp?.fire(weaponType);
    sfx.shotAt(origin, weaponType ?? 0, rp?.vel);
    // Instant classes (beam weld, melee swing) paint the same flash the
    // shooter sees along the claimed aim — cosmetic only.
    if (dir && Number.isFinite(dir.x + dir.y + dir.z)) {
      const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
      if (Number.isFinite(d.x + d.y + d.z)) {cosmeticShot(id, weaponType, origin, d);}
    }
  };

  // The gone edge carries the authority's contact point — the replica's
  // replay drifts past it by ~a transit of flight, so exploding where
  // the replay stood would center the predicted blast meters off the
  // real one (every blast stamp then misses its knockback echo and the
  // shove lands twice). Snap to the wire point before exploding.
  const snapToContact = (p: Projectile, at?: { x: number; y: number; z: number }): void => {
    if (!at || !Number.isFinite(at.x + at.y + at.z)) {return;}
    p.pos.set(at.x, at.y, at.z);
    p.prevPos.copy(p.pos);
    p.hitPoint.copy(p.pos);
    p.hitPointValid = true; // the blast renders HERE, not a stale sweep point
    p.renderOffset.set(0, 0, 0);
    p.rendered.copy(p.pos);
  };

  networkManager.onProjectileDestroyed = (projectileId: string, shotId?: string, position?: { x: number; y: number; z: number }): void => {
    if (deps.world.playbackMode) {return;}
    // Kill remote projectile (explode so trail particles fade out naturally).
    // Delete the map entry now — the visual fade lives on world.projectiles,
    // not this map; keeping dead entries leaks one record per shot ever fired.
    const remoteProjectile = remoteProjectiles.get(projectileId);
    if (remoteProjectile) {
      snapToContact(remoteProjectile, position);
      remoteProjectile.explode(); // onExploded records + unmaps
    }
    // Kill local projectile if server says it's gone — explode to let
    // trails fade. The shotId covers destroys for shells whose server-id
    // echo never landed.
    const registry = deps.world.projectileRegistry;
    // The authority's blast point for MY shell — damage-echo ghosts diff
    // it against where the hit painted to tell trajectory divergence
    // (srvAt far) from a shell that never ran (srvAt none). Key on the
    // echoed nonce, NOT a registry hit: the predicted shell self-destructs
    // on its painted contact, so pruneShots evicts it before 'gone'
    // lands — keying on localProjectile reported srvAt:none on every
    // real miss by construction.
    if (position && shotId) {noteShellFate(shotId, position);}
    const localProjectile = registry.byId.get(projectileId)
      ?? (shotId ? registry.byShotId.get(shotId) : undefined);
    if (localProjectile) {
      snapToContact(localProjectile, position);
      localProjectile.explode();
      registry.byId.delete(projectileId);
      if (localProjectile.shotId) {registry.byShotId.delete(localProjectile.shotId);}
      if (localProjectile.fanSlot) {registry.byFanSlot.delete(localProjectile.fanSlot);}
    }
  };

  // Belt-sticky combo: the authority swallowed a belt sticky onto a
  // same-owner shell — parent the replica so it rides dead-center and
  // pops at the host's contact point (own shots already predicted the
  // catch; setting .host again is idempotent).
  networkManager.onProjRide = (riderId, hostId): void => {
    const reg = deps.world.projectileRegistry;
    const rider = remoteProjectiles.get(riderId) ?? reg.byId.get(riderId);
    const host = remoteProjectiles.get(hostId) ?? reg.byId.get(hostId);
    if (rider && host) {rider.host = host;}
  };
}
