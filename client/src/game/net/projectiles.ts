// Server-authoritative projectile lifecycle - remote spawns/destroys and
// the pending-link handshake for our own shots.

import * as THREE from 'three';
import * as sfx from '../../core/sfx.js';
import { Projectile } from '../../projectiles/Projectile.js';
import { BOLT_CONFIG, getProjectileConfig } from '../../projectiles/index.js';
import { WeaponType, getWeaponStats, LANCE_RANGE } from '../../../../shared/weapons.js';
import { GRAVITY } from '../../../../shared/movement.js';
import { Explosion } from '../../effects/explosion.js';
import { swingSwipe } from '../../effects/swingTrails.js';
import { MELEE_RANGE, EXPLOSION_VFX_RADIUS, LG_RANGE, LG_BOUNCE_RANGE } from '../../core/config.js';
import { noteShellFate, noteTrajDiv, parityProbes, parityMiss, projWireAt } from '../parity.js';
import { histAt } from '../combat/fire.js';
import { kineticHitFx } from '../combat/impact.js';
import type { NetCtx } from './ctx.js';
const snapToContact = (p: Projectile, at?: { x: number; y: number; z: number }): number => {
  if (!at || !Number.isFinite(at.x + at.y + at.z)) {return -1;}
  const preSnap = Math.hypot(p.pos.x - at.x, p.pos.y - at.y, p.pos.z - at.z);
  p.pos.set(at.x, at.y, at.z);
  p.prevPos.copy(p.pos);
  p.hitPoint.copy(p.pos);
  p.hitPointValid = true; // the blast renders HERE, not a stale sweep point
  p.renderOffset.set(0, 0, 0);
  p.rendered.copy(p.pos);
  return preSnap;
};


/** Last weapon + shot count seen per shooter - every remote fire event
 *  funnels through here (botFire markers included), so alt+w can audit
 *  what each bot is actually drawing. */
export const lastWeaponByPlayer = new Map<string, { wt: number; n: number }>();
function noteWeapon(id: string, weaponType: number | undefined): void {
  if (weaponType === undefined) {return;}
  const rec = lastWeaponByPlayer.get(id) ?? { wt: 0, n: 0 };
  rec.wt = weaponType;rec.n += 1;
  lastWeaponByPlayer.set(id, rec);
}

const _bP = new THREE.Vector3(); // lightning bounce-march scratch
const _lgStart = new THREE.Vector3();
const _sweepGhost = new THREE.Vector3(); // remote-shell local-victim rewind pos

// Lightning terrain bounce, observer side: ground stop → arc to the
// nearest remote player within LG_BOUNCE_RANGE of the contact (any
// angle), else the observed bolt terminates at the contact like the
// shooter's does. Cosmetic - the server's pick is the truth.
// Beam start is the shooter's rendered muzzle when it's sane (the wire
// origin is the server eye position; a beam issuing from the chest reads
// detached in third person). The contact march stays on the aim line -
// only the drawn start moves.
function paintLgBeam(deps: NetCtx['deps'], ownerId: string, origin: THREE.Vector3, dir: THREE.Vector3): void {
  const shooter = deps.world.remotePlayers.get(ownerId);
  const start = shooter?.model?.muzzleWorld(_lgStart)
    && _lgStart.distanceToSquared(origin) < 4 ? _lgStart : origin;
  const terr = deps.lazyTerrain();
  for (let d = 1.5; d <= LG_RANGE; d += 1.5) {
    _bP.copy(origin).addScaledVector(dir, d);
    if (_bP.y < terr.getHeight(_bP.x, _bP.z)) {
      deps.lazyEffects().spawnBeam(start, _bP, 0x8F_DC_FF);
      let bestD2 = LG_BOUNCE_RANGE * LG_BOUNCE_RANGE;
      let hit: THREE.Vector3 | null = null;
      for (const rp of deps.world.remotePlayers.values()) {
        if (rp.isDead) {continue;}
        const d2 = _bP.distanceToSquared(rp.pos) - 0.5; // capsule slack
        if (d2 < bestD2) { bestD2 = d2; hit = rp.pos; }
      }
      if (hit) {deps.lazyEffects().spawnBeam(_bP, hit, 0x8F_DC_FF);}
      return;
    }
  }
  deps.lazyEffects().spawnBeam(start, origin.clone().addScaledVector(dir, LG_RANGE), 0x8F_DC_FF);
}

// Shocklance zap, observer side: three colored rods fanning the honest
// stop (terrain march like the shooter's own trace) + the layered arc
// burst only when it lands - same "air shots stay invisible" rule.
const LANCE_STRAND_COLORS = [0xA0_50_FF, 0x40_70_FF, 0xFF_C0_50] as const;
const _lanceUp = new THREE.Vector3();
const _lanceSide = new THREE.Vector3();
const _lanceTip = new THREE.Vector3();
function paintLanceBolt(deps: NetCtx['deps'], origin: THREE.Vector3, dir: THREE.Vector3): void {
  const terr = deps.lazyTerrain();
  let d = LANCE_RANGE;
  for (let m = 1.5; m <= LANCE_RANGE; m += 1.5) {
    _bP.copy(origin).addScaledVector(dir, m);
    if (_bP.y < terr.getHeight(_bP.x, _bP.z)) { d = m; break; }
  }
  _bP.copy(origin).addScaledVector(dir, d);
  // Fan the strand tips around the contact - same storm read as the
  // shooter's triple-beam, at rod-Flash cost.
  _lanceUp.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.7) {_lanceUp.set(1, 0, 0);}
  _lanceSide.crossVectors(dir, _lanceUp).normalize();
  _lanceUp.crossVectors(_lanceSide, dir).normalize();
  for (let i = 0; i < LANCE_STRAND_COLORS.length; i += 1) {
    const fan = i - 1; // -1, 0, +1
    // On a whiff each strand bleeds out at a different depth (0.62/0.78/
    // 0.94 of the stop) - ragged along the SAME tight line: the stagger
    // sells dissipation without the fan reading as a scattergun.
    const reach = d < LANCE_RANGE ? d : d * (0.62 + i * 0.16);
    _lanceTip.copy(origin).addScaledVector(dir, reach)
      .addScaledVector(_lanceSide, fan * 0.4)
      .addScaledVector(_lanceUp, fan * 0.18);
    deps.lazyEffects().spawnBeam(origin, _lanceTip, LANCE_STRAND_COLORS[i]!);
  }
  deps.world.explosions.push(new Explosion(
    // Landed: center on the true contact. Whiff: pop at the farthest
    // strand's end - the charge's last reach before it crackles out.
    deps.lazyScene(), d < LANCE_RANGE ? _bP : _lanceTip, true, 0, terr,
    (d < LANCE_RANGE ? 5.5 : 2.4) / EXPLOSION_VFX_RADIUS,
    d < LANCE_RANGE ? 0xB0_60_FF : 0x90_50_FF, 'arc',
  ));
}

export function wireProjectiles(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;

  const remoteProjectiles = new Map<string, Projectile>();
  let remoteProjectilesFloodWarned = 0;

  // Melee swings carry a fake velocity (it's a swing marker, not a shell)
  // - painting the generic projectile would fly a rocket out of a fist.
  const meleeFlash = (origin: THREE.Vector3, dirV: THREE.Vector3): void => {
    const hit = origin.clone().addScaledVector(dirV.normalize(), MELEE_RANGE * 0.7);
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), hit, true, 0, deps.lazyTerrain(),
      (getWeaponStats(WeaponType.Melee).aoeRadius * 0.7) / EXPLOSION_VFX_RADIUS, 0xAA_DD_FF, 'punch',
    ));
    // Enemy swings get the slash arc too - the streak is what makes a
    // punch readable at range (there's no arm animation to read).
    swingSwipe(deps.lazyScene(), origin, dirV);
  };

  // Swing markers and beam-class weapon fire carry no projectile body -
  // the message is cosmetic, so paint the punch flash / instant shaft a
  // player's weld paints instead of flying a slow fake bolt. */
  const cosmeticShot = (ownerId: string, weaponType: number | undefined, origin: THREE.Vector3, dir: THREE.Vector3): boolean => {
    if (weaponType === WeaponType.Melee) {
      meleeFlash(origin, dir);
    } else if (weaponType === WeaponType.Lightning) {
      paintLgBeam(deps, ownerId, origin, dir);
    } else if (weaponType === WeaponType.Shocklance) {
      paintLanceBolt(deps, origin, dir);
    } else {
      return false;
    }
    deps.world.remotePlayers.get(ownerId)?.fire(weaponType);
    sfx.shotAt(origin, weaponType, deps.world.remotePlayers.get(ownerId)?.vel);
    return true;
  };

  // Bind a server id echo to the local shell that spawned it - the spawn
  // claim's shotId nonce comes back verbatim, so the link is exact (no
  // FIFO, no position inference, immune to rejected/dropped claims).
  const linkOwnProjectile = (projectileId: string, shotId: string | undefined, pellet: number | undefined, position?: { x: number; y: number; z: number }, velocity?: { x: number; y: number; z: number }, srvAge?: number, srvT?: number): void => {
    const registry = deps.world.projectileRegistry;
    let localProjectile;
    if (shotId) {
      localProjectile = pellet === undefined ? registry.byShotId.get(shotId) : registry.byFanSlot.get(`${shotId}#${pellet}`);
    }
    if (!localProjectile) {
      // A missing entry after the nonce mint is either an echo that
      // outlived a fast-popping shell (nonce pruned at death - benign)
      // or a spawn that never sent shotId - a real wiring break.
      if (shotId === undefined) {
        deps.logger.warn(`[Net] projectileCreated ${projectileId} for an own shot carrying no shotId`);
      } else {
        deps.logger.debug(`[Net] projectileCreated ${projectileId} echo for a dead shell (shotId=${shotId})`);
      }
      return;
    }
    localProjectile.serverProjectileId = projectileId;
    localProjectile.boundAtAge = localProjectile.age;
    registry.byId.set(projectileId, localProjectile);
    // Re-anchor onto the authority's arc: the server spawned at its
    // rewind-origin with shadow-vel inherit, so the claim's live spawn
    // state diverges by ~a transit of motion - compounding to 100m+
    // over a flat flyer's fuse (the traj-outlier class). The echo's
    // pos/vel IS the server's spawn state; project it forward by the
    // server shell's age (~replica age minus claim transit).
    if (position && velocity
        && Number.isFinite(position.x + position.y + position.z + velocity.x + velocity.y + velocity.z)) {
      // Exact server age on the echo beats the ping estimate - the wire
      // now carries it; + (serverNow − srvT) measures the echo's own
      // queue delay so a stalled create can't reset the clock backward
      // (the traj-epoch starvation class). Fall back to the transit
      // estimate on old peers.
      const serverNow = nm().serverNowMs?.();
      const exactAge = srvAge !== undefined && srvT !== undefined && serverNow !== undefined
        ? srvAge + Math.max(0, (serverNow - srvT) / 1000)
        : srvAge;
      localProjectile.reanchorTo(position, velocity,
        exactAge ?? Math.max(0, localProjectile.age - (nm().serverPingMs ?? nm().getPing()) / 2000));
      // Demo: the authority just corrected this arc mid-flight — a Bounce
      // edge is the format's "re-seat on recorded state" checkpoint, so
      // validators/replay diff against the corrected arc, not the claim's.
      if (localProjectile.demoProjectileId) {
        deps.lazyDemoManager?.()?.recordProjectileBounce(
          localProjectile.demoProjectileId,
          localProjectile.pos, localProjectile.vel, localProjectile.vel.clone().normalize());
      }
    }
    // Burst pellet binding is one-shot - the slot frees once linked.
    if (localProjectile.fanSlot) {
      registry.byFanSlot.delete(localProjectile.fanSlot);
      localProjectile.fanSlot = null;
    }
  };

  networkManager.onProjectileCreated = (projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number, shotId?: string, pellet?: number, srvAge?: number, srvT?: number): void => {
    if (deps.world.playbackMode) {return;} // live shots don't belong in the replay
    // Hidden tabs render nothing and the un-hide resync reaps remote
    // shells anyway — spawning them anyway just piles up a backlog the
    // 512 map-cap doesn't cover (the 709-shell drop + TrailDriver churn).
    if (document.hidden) {return;}
    noteWeapon(ownerId, weaponType);
    // For own projectiles: link the server id to the local shell by nonce.
    if (ownerId === nm().getLocalPlayerId()) {
      linkOwnProjectile(projectileId, shotId, pellet, position, velocity, srvAge, srvT);
      return;
    }

    // NaN spawn vectors seed a NaN trajectory - and a NaN trail emitter
    // paints the whole sky. normalize() on a zero vector is NaN too.
    if (!Number.isFinite(position.x + position.y + position.z
        + velocity.x + velocity.y + velocity.z)) {return;}
    // Cap BEFORE constructing - a rejected spawn that already built its
    // Projectile leaks the TrailDriver, ribbons, quarks system and scene
    // meshes: the driver keeps ticking forever, pushing into pooled slots
    // (the 4M zombiePushes / 11k drivers flood after a hidden-tab pileup).
    if (remoteProjectiles.size >= 512) {
      if (remoteProjectilesFloodWarned === 0) {deps.logger.warn('[Net] remote projectile cap hit - dropping further spawns');}
      remoteProjectilesFloodWarned += 1;
      return;
    }
    const vel = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const dir = vel.lengthSq() > 0 ? vel.clone().normalize() : new THREE.Vector3(0, 0, 1);
    if (cosmeticShot(ownerId, weaponType, origin, dir)) {return;}
    const cfg = (weaponType === undefined ? undefined : getProjectileConfig(weaponType)) ?? BOLT_CONFIG;
    const remoteProjectile = new Projectile(deps.lazyScene(), origin, dir, new THREE.Vector3(0, 0, 0), cfg);
    remoteProjectile.vel.copy(vel); // override with exact server velocity
    remoteProjectile.isRemote = true;
    // Cosmetic body-pop needs the local body too - same lazy reads the
    // own-shell path uses (null while dead = no sweep target).
    // Local-body pop judges us at the rewind epoch the server's bodySweep
    // does - ghostBack ≈ 0.7·(shooter transit + render lag) - not the
    // live body, or a shell pops on us ~a transit early and the wire
    // 'gone' lands a full speed·transit ahead (self:0 traj-outlier).
    remoteProjectile.sweepLocal = (): THREE.Vector3 | null => {
      const pl = deps.lazyPlayer();
      if (pl.isDead) {return null;}
      // Server-side ghost-back for OUR body is shooterUplink +
      // shooterViewLagOfUs − ourUplink - under symmetric links the
      // transit terms cancel and the remainder is the shooter's view
      // lag, which we measure locally as viewLagMs on that remote.
      // Fallback = our own one-way uplink (ping/2), not the old
      // 0.35·rtt estimate that sat between the epochs of nothing.
      const rp = deps.world.remotePlayers.get(ownerId);
      // Full rewind = shooterTransit + shooterViewLag − myTransit: the
      // shooter's viewLag alone is (shooterPing−myPing)/2 shallow - a
      // fat-pipe shooter's server body-sweeps me ~90ms deeper.
      const myPing = nm().serverPingMs ?? nm().getPing() ?? 0;
      const backMs = rp && rp.viewLagMs > 0 ? rp.rewindLocalMs(myPing)
        : myPing / 2;
      const m = histAt(deps.world.localPosHistory, backMs);
      if (!m) {return pl.pos;}
      _sweepGhost.set(m.x, m.y, m.z);
      return _sweepGhost;
    };
    remoteProjectile.localClass = (): string | undefined => deps.lazyPlayer().appliedClass;
    // The shooter's rendered remote can sit a leash-width off the server's
    // spawn point - seed the render offset from the model we see so the
    // shell leaves that muzzle and blends onto the true trajectory instead
    // of popping in offset from the model while the flash plays on it.
    // Beyond ~10m the remote is mid-reseat anyway; a swooping shell reads
    // worse than the pop there.
    const rp = deps.world.remotePlayers.get(ownerId);
    // Wire shells are NEVER "mine" - unset shooterId reads as local player
    // authorship in every feedback gate (hitmarker/numbers/self-splash
    // scale) and would even let a remote shell sendShot-claim its hits
    // under my id. Stamp the real owner.
    remoteProjectile.shooterId = ownerId;
    // Roster team - team-filtered solids (shield gates) pass an owner's
    // shell through when it matches, same as the server sim.
    remoteProjectile.shooterTeam = nm().getPlayers().get(ownerId)?.team ?? null;
    // Fuse jitter seeds from this id - the replica pops at the server's age.
    remoteProjectile.serverProjectileId = projectileId;
    // Ray-burst replicas discharge deterministically (delay/dir/range are
    // spawn-derived) - hook the beam flash so observers see the rail too.
    if (cfg.rayBurst) {
      const beamColor = cfg.glowColor;
      remoteProjectile.onRayBurst = (from, to): void => {
        deps.lazyEffects().spawnBeam(from, to, beamColor);
        sfx.at(from, 'shot_energy', 0.9, 1.3);
      };
    }
    remoteProjectile.spawnedThisFrame = false; // remote projectiles don't need first-frame skip
    const shooterVel = deps.world.remotePlayers.get(ownerId)?.vel;
    // Epoch: srvAge + (serverNow − srvT) is exact when both stamps ride
    // the echo - intent lag AND echo transit measured, nothing guessed.
    // Old peers/unsynced clock fall back to srvAge + half-RTT estimate.
    const serverNow = nm().serverNowMs?.();
    const exactAge = srvAge !== undefined && srvT !== undefined && serverNow !== undefined
      ? srvAge + Math.max(0, (serverNow - srvT) / 1000)
      : undefined;
    const ttl = remoteProjectile.fuseTtl?.() ?? 0;
    if (exactAge !== undefined && ttl > 0 && exactAge >= ttl) {
      remoteProjectile.dispose();
      parityProbes.deadOnArrival += 1;
      return;
    }
    const lead = exactAge ?? (srvAge ?? 0) + Math.min(0.15, (nm().serverPingMs ?? nm().getPing()) / 2000);
    // Render the replica leaving the shooter's rendered muzzle, not
    // popping in `lead` meters downrange: the sim position stays
    // wire-true (impact alignment), renderOffset walks the visual back
    // to the muzzle and blends forward at ≤10% of shell speed. A
    // past-cap splice just pops - same unbrick as before.
    if (rp && lead > 0) {
      remoteProjectile.renderOffset.copy(rp.position).sub(origin).addScaledVector(remoteProjectile.vel, -lead);
      if (remoteProjectile.renderOffset.lengthSq() > 100) {remoteProjectile.renderOffset.set(0, 0, 0);}
    } else if (rp) {
      remoteProjectile.renderOffset.copy(rp.position).sub(origin);
      if (remoteProjectile.renderOffset.lengthSq() > 100) {remoteProjectile.renderOffset.set(0, 0, 0);}
    }
    if (lead > 0) {
      remoteProjectile.advanceBy(lead);
    }
    deps.world.projectiles.push(remoteProjectile);
    remoteProjectiles.set(projectileId, remoteProjectile);
    // Wire destroy only covers server-simmed shells - claim-path replicas
    // die locally on fuse/terrain, so record the death wherever it happens
    // and release the map entry either way.
    remoteProjectile.onExploded = (): void => {
      deps.lazyDemoManager?.()?.recordRemoteProjectileDestroyed(projectileId, remoteProjectile.pos);
      remoteProjectiles.delete(projectileId);
    };
    remoteProjectile.onDemoBounce = (pos, vel, normal): void => {
      deps.lazyDemoManager?.()?.recordRemoteProjectileBounce(projectileId, pos, vel, normal);
    };
    deps.lazyDemoManager?.()?.recordRemoteProjectileFired(projectileId, position, velocity, weaponType ?? cfg.weaponType, ownerId);
    // Gun recoil kick on the shooter's remote model
    deps.world.remotePlayers.get(ownerId)?.fire(weaponType);
    sfx.shotAt(origin, cfg.weaponType, shooterVel);
  };

  // Hitscan fire relay - observers get muzzle audio at the shooter's
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
    // shooter sees along the claimed aim - cosmetic only.
    if (dir && Number.isFinite(dir.x + dir.y + dir.z)) {
      const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
      if (Number.isFinite(d.x + d.y + d.z)) {cosmeticShot(id, weaponType, origin, d);}
    }
  };

  // The gone edge carries the authority's contact point - the replica's
  // replay drifts past it by ~a transit of flight, so exploding where
  // the replay stood would center the predicted blast meters off the
  // real one (every blast stamp then misses its knockback echo and the
  // shove lands twice). Snap to the wire point before exploding.

  networkManager.onProjectileDestroyed = (projectileId: string, shotId?: string, position?: { x: number; y: number; z: number }, srvAge?: number): void => {
    parityProbes.destroysSeen += 1;
    if (deps.world.playbackMode) {return;}
    // Kill remote projectile (explode so trail particles fade out naturally).
    // Delete the map entry now - the visual fade lives on world.projectiles,
    // not this map; keeping dead entries leaks one record per shot ever fired.
    // Attach the wire detonation to any self-shove stamp this replica
    // painted - a self-popped replica is already off the map, so this
    // can't live inside the `remoteProjectile` check below. Stamps that
    // miss are exactly the self-pops (wire-snap users got the point).
    if (position) {
      projWireAt.set(projectileId, { at: position, t: performance.now() });
      for (const k of projWireAt.keys()) {if (performance.now() - projWireAt.get(k)!.t > 15_000) {projWireAt.delete(k);}}
      for (const s of deps.world.selfBlastStamps) {
        // Re-center the stamp on the wire point - the echo arrives at
        // the server's detonation, so a painted-center stamp misses a
        // legitimate echo (double-shove + false kb-echo).
        if (s.pid === projectileId) {s.wireAt = position; s.wireT = performance.now(); s.x = position.x; s.y = position.y; s.z = position.z;}
      }
    }
    const remoteProjectile = remoteProjectiles.get(projectileId);
    if (remoteProjectile) {
      snapToContact(remoteProjectile, position);
      remoteProjectile.popClass = 'wire'; // the authority's detonation, not a painted contact
      remoteProjectile.explode(); // onExploded records + unmaps
      // Body-hit replica suppressed its predicted blast (ghostBodyPop) -
      // the wire owns the real detonation, so paint it at the stamped
      // contact point now.
      if (remoteProjectile.ghostBodyPop && position) {
        const p = remoteProjectile;
        const at = new THREE.Vector3(position.x, position.y, position.z);
        if (p.config.noExplosion) {
          // noExplosion shells never painted a dome to suppress - the wire
          // point owes the same kinetic pop their contact path draws.
          kineticHitFx(deps, p, at);
        } else {
          deps.world.explosions.push(new Explosion(
            deps.lazyScene(), at, true, p.age, deps.lazyTerrain(),
            p.explosionRadius / EXPLOSION_VFX_RADIUS, p.config.damageColor, p.config.vfx));
          // blastFx records every other blast here - without it the wire
          // knockback echo finds no blast and warns + paints a phantom boom.
          deps.explosionTracker.addExplosion(at, p.force, p.shooterId ?? deps.lazyNetworkManager().getLocalPlayerId());
        }
      }
    }
    // Kill local projectile if server says it's gone - explode to let
    // trails fade. The shotId covers destroys for shells whose server-id
    // echo never landed.
    const registry = deps.world.projectileRegistry;
    // The authority's blast point for MY shell - damage-echo ghosts diff
    // it against where the hit painted to tell trajectory divergence
    // (srvAt far) from a shell that never ran (srvAt none). Key on the
    // echoed nonce, NOT a registry hit: the predicted shell self-destructs
    // on its painted contact, so pruneShots evicts it before 'gone'
    // lands - keying on localProjectile reported srvAt:none on every
    // real miss by construction.
    if (position && shotId) {noteShellFate(shotId, position);}
    const localProjectile = registry.byId.get(projectileId)
      ?? (shotId ? registry.byShotId.get(shotId) : undefined);
    if (localProjectile) {
      // Same-epoch comparison: the wire gone's `age` is the server shell's
      // fuse-time; the replica's clock only differs by transit+starvation.
      // Project the replica's ballistic state to srvAge (closed form -
      // Δ can be negative when the uplink starved and the server shell
      // out-lived our copy). Epochs too far apart are an epoch-mismatch
      // class (bounces/fuse-jitter make projection meaningless), counted
      // separately so it can't masquerade as arc divergence.
      // Read pos BEFORE the snap moves it.
      let preSnap = -1;
      if (position && Number.isFinite(position.x + position.y + position.z)) {
        const epoch = srvAge === undefined ? -(nm().serverPingMs ?? nm().getPing()) / 2000
          : srvAge - localProjectile.age;
        if (Math.abs(epoch) > 0.75) {
          parityMiss('traj-epoch', { wt: localProjectile.config.weaponType, self: localProjectile.exploded ? 1 : 0,
            age: Number(localProjectile.age.toFixed(2)), sa: srvAge === undefined ? '?' : Number(srvAge.toFixed(2)),
            bind: Number(localProjectile.boundAtAge.toFixed(2)), mir: localProjectile.mirrored ? 1 : 0 });
        } else {
          const { vel } = localProjectile;
          preSnap = Math.hypot(
            localProjectile.pos.x + vel.x * epoch - position.x,
            localProjectile.pos.y + vel.y * epoch + (localProjectile.config.gravity ? 0.5 * GRAVITY * epoch * epoch : 0) - position.y,
            localProjectile.pos.z + vel.z * epoch - position.z);
        }
        snapToContact(localProjectile, position);
      } else {
        preSnap = snapToContact(localProjectile, position);
      }
      // offM as a population - replica-vs-fate distance for every owned
      // shell, not just the ones that painted a ghost hit. Outliers tag
      // weapon + whether the replica already popped on its own contact.
      // Bounced replicas measured their own counter - post-bounce linear
      // extrapolation can't recover the real path, so a legit ricochet
      // reads as huge arc divergence and buries the spawn-divergence p50.
      if (preSnap >= 0) {
        if (localProjectile.bouncesTaken > 0) {parityProbes.trajBounced = (parityProbes.trajBounced ?? 0) + 1;}
        else {noteTrajDiv(preSnap, localProjectile.config.weaponType, localProjectile.exploded, localProjectile.age, localProjectile.boundAtAge, srvAge, localProjectile.mirrored);}
      }
      localProjectile.explode();
      // Same ghostBodyPop repaint as the replica branch above - MY shell's
      // predicted blast was suppressed for the wire's contact point too.
      if (localProjectile.ghostBodyPop && position) {
        const p = localProjectile;
        const at = new THREE.Vector3(position.x, position.y, position.z);
        if (p.config.noExplosion) {
          kineticHitFx(deps, p, at);
        } else {
          deps.world.explosions.push(new Explosion(
            deps.lazyScene(), at, true, p.age, deps.lazyTerrain(),
            p.explosionRadius / EXPLOSION_VFX_RADIUS, p.config.damageColor, p.config.vfx));
          deps.explosionTracker.addExplosion(at, p.force, p.shooterId ?? deps.lazyNetworkManager().getLocalPlayerId());
        }
      }
      registry.byId.delete(projectileId);
      if (localProjectile.shotId) {registry.byShotId.delete(localProjectile.shotId);}
      if (localProjectile.fanSlot) {registry.byFanSlot.delete(localProjectile.fanSlot);}
    }
  };

  // Belt-sticky combo: the authority swallowed a belt sticky onto a
  // same-owner shell - parent the replica so it rides dead-center and
  // pops at the host's contact point (own shots already predicted the
  // catch; setting .host again is idempotent).
  networkManager.onProjRide = (riderId, hostId): void => {
    const reg = deps.world.projectileRegistry;
    const rider = remoteProjectiles.get(riderId) ?? reg.byId.get(riderId);
    const host = remoteProjectiles.get(hostId) ?? reg.byId.get(hostId);
    if (rider && host) {rider.host = host;}
  };
}
