/**
 * combat/projectiles — the per-frame projectile pipeline: explosion
 * processing (blast fx, force, armor nades, AOE claims), pending-shot
 * prune, turret-bolt interceptions, sticky chain detonations, and the
 * update loop itself. combat.ts keeps deps + factory wiring.
 */
import * as THREE from 'three';
import type { Projectile } from '../../projectiles/Projectile.js';
import { getProjectileConfig } from '../../projectiles/index.js';
import { Explosion } from '../../effects/explosion.js';
import { AoeGizmo } from '../../effects/aoeGizmo.js';
import { Implosion } from '../../effects/implosion.js';
import { ScorchDecal } from '../../effects/scorch.js';
import * as sfx from '../../core/sfx.js';
import { screenShake } from '../../effects/screenShake.js';
import { PENDING_ROCKET_TIMEOUT, EXPLOSION_VFX_RADIUS } from '../../core/config.js';
import { urlParams } from '../../core/params.js';
import { getWeaponStats, WeaponType, AOE_VFX_SCALE, ARMORNADE_ARMOR } from '../../../../shared/weapons.js';
import { POWERUP } from '../../../../shared/pickups.js';
import { handleProjectileImpact } from './impact.js';
import type { CombatCtx, ExplosionArgs } from '../combat.js';

const SCORCH_MAX = 48;

// Turret-bolt interception: clip a lobbed shell with an explosive and it
// cooks off mid-air — huge blast (the shell's own payload going off), so
// shooting the bolt down NEXT to its turret is a real counterattack.
const BOLT_MEGA_RADIUS = 13.0;     // bolt's land-splash is ~5m — cookoff is way bigger
const BOLT_MEGA_DAMAGE = 60;
const BOLT_MEGA_FORCE = 55;
const BOLT_CHAIN_RADIUS = 8.0;     // cookoff blast pops neighboring shells too
const BOLT_CHAIN_PASSES = 3;       // bounded worklist — a chain can't run away

// ?debug — show the real gameplay blast radius as a wireframe sphere on
// every detonation (the dome VFX is only 80% of it by design)
const AOE_DEBUG = urlParams.debug;

// Remote player positions for projectile collision — rebuilt per frame into
// the same Map (zeroed allocations in the hot loop)
const _remotePlayerPositions = new Map<string, THREE.Vector3>();

// ---- Projectile explosion processing (push or pull based on config) ----
// VFX radius is decoupled from gameplay radius — aoeRadius intentionally
// exceeds the visual dome so damage covers the shock ring, not just the dome.
// Blast presentation layer: explosion/implosion entity, positional audio,
// screenshake, and the terrain scorch decal. All visuals, no gameplay.
function blastFx(c: CombatCtx, a: ExplosionArgs): void {
  const deps = c.deps;
  const { pos, radius, forceMode } = a;
  const directHit = a.directHit ?? false;
  const vfx = a.vfxRadius ?? radius;
  // Impact VFX variant — config-driven (sprinkler splashes, doesn't burn)
  const vfxKind = a.vfx ?? (a.weaponType !== undefined ? getProjectileConfig(a.weaponType)?.vfx : undefined);
  if (forceMode === 'push') {
    deps.world.explosions.push(new Explosion(deps.lazyScene(), pos, directHit, a.age ?? 0, deps.lazyTerrain(), vfx / EXPLOSION_VFX_RADIUS, a.explosionTint, vfxKind));
    sfx.explosionAt(pos, directHit, a.weaponType);
    screenShake.blast(pos, vfx, deps.lazyPlayer().pos);
  } else {
    deps.world.implosions.push(new Implosion(deps.lazyScene(), pos, a.age ?? 0, deps.lazyTerrain()));
    sfx.implosionAt(pos, directHit);
    screenShake.blast(pos, vfx * 0.5, deps.lazyPlayer().pos);
  }
  // Scorch only when the blast is near the ground — a midair hit would
  // otherwise paint a phantom mark on terrain far below. Water doesn't
  // scorch: splash blasts skip the decal entirely.
  if (vfxKind !== 'splash' && pos.y - deps.lazyTerrain().getHeight(pos.x, pos.z) <= vfx) {
    if (deps.world.scorches.length >= SCORCH_MAX) {
      deps.world.scorches.shift()!.dispose();
    }
    deps.world.scorches.push(new ScorchDecal(deps.lazyScene(), deps.lazyTerrain(), pos, vfx * 0.6));
  }
  if (AOE_DEBUG) deps.world.aoeGizmos.push(new AoeGizmo(deps.lazyScene(), pos, radius));
}

export function processProjectileExplosion(c: CombatCtx, a: ExplosionArgs): void {
  const deps = c.deps;
  const { pos, radius, force, forceMode, aoeDamage } = a;
  blastFx(c, a);

  // Record explosion for death impulse calculation
  deps.explosionTracker.addExplosion(pos, force, a.shooterId || deps.lazyNetworkManager().getLocalPlayerId());

  c.applyExplosionForce({ pos, radius, force, forceMode, falloffMultiplier: a.falloffMultiplier, collisionMultiplier: a.collisionMultiplier, forceMultiplier: a.forceMultiplier, aoeDamage, directHitTargetId: a.directHitTargetId ?? null, weaponType: a.weaponType, shooterId: a.shooterId });

  // Armor grenade: predict the plating the server grants so the HUD armor
  // jumps with the blast, not on the next tick. Enemy plating stays
  // server-side — we never predict another player's armor pool.
  if (a.weaponType === WeaponType.ArmorGrenade) {
    const player = deps.lazyPlayer();
    if (player.pos.distanceTo(pos) <= radius) {
      player.armor = Math.min(POWERUP.maxArmor, player.armor + ARMORNADE_ARMOR);
    }
  }

  // AOE damage to remote players (server-side authority)
  const networkManager = deps.lazyNetworkManager();
  if (networkManager && networkManager.isConnected() && a.sendAOE) {
    a.sendAOE({ x: pos.x, y: pos.y, z: pos.z }, a.directHitTargetId ?? null);
  }
}

// Q-skill Slam landing — the "explosion" is the player hitting terrain.
// Runs through the same blast path as projectiles so prediction,
// particles, scorch, and the server aoeShot all behave identically.
export function slam(c: CombatCtx, pos: THREE.Vector3, impactSpeed: number): void {
  const deps = c.deps;
  const stats = getWeaponStats(WeaponType.Slam);
  // Blast scales with landing speed: the skill spikes you at 55 m/s, so a
  // tap-slam lands ~55 and a full dive can exceed 100. ~0.2 at a lazy hop
  // floor, 1.8 max on a huge fall. Server applies the same power factor.
  const power = Math.min(Math.max((impactSpeed - 30) / 50, 0.2), 1.8);
  const networkManager = deps.lazyNetworkManager();
  const sendAOE = (p: { x: number; y: number; z: number }, targetId: string | null) =>
    networkManager.sendAOEShot({ position: p, weaponType: WeaponType.Slam, excludeTargetId: targetId, power });
  processProjectileExplosion(c, {
    pos,
    radius: stats.aoeRadius * power * deps.lazyPlayer().mods.aoeRadius,
    force: stats.knockbackForce * power,
    forceMode: stats.forceMode,
    aoeDamage: stats.aoeDamage * power,
    falloffMultiplier: 1, collisionMultiplier: 1, forceMultiplier: 1,
    // no directHit — slam has no proxy-hit bonus layer
    sendAOE,
    explosionTint: 0xffcc66,               // hot slam flash
    vfxRadius: stats.aoeRadius * power * AOE_VFX_SCALE, // VFX = 80% of damage reach
  });
}

// ---- Update projectiles ----
// Pending shots that never got a server ack age out — the registry is
// the only thing linking our local projectile to its wire id.
function prunePendingShots(c: CombatCtx): void {
  const deps = c.deps;
  const now = Date.now();
  const registry = deps.world.projectileRegistry;
  for (let i = registry.pending.length - 1; i >= 0; i--) {
    const p = registry.pending[i];
    if (now - (registry.pendingSince.get(p) || 0) > PENDING_ROCKET_TIMEOUT) {
      registry.pending.splice(i, 1);
      registry.pendingSince.delete(p);
    }
  }
}

// Mid-air interception: the projectile's sweep tagged a turret shell —
// cook it at the exact swept contact, then ripple the mega blast through
// neighboring shells with a bounded worklist (no infinite chain).
function collectBoltIntercept(c: CombatCtx, p: Projectile): void {
  const deps = c.deps;
  if (!p.hitBolt || !deps.consumeBolt) return;
  const bolt = p.hitBolt;
  // Consume once — an exploded projectile lives on until its trail fades,
  // and an uncleared hitBolt would re-fire the mega blast every frame.
  p.hitBolt = null;
  const at = p.hitPointValid ? p.hitPoint : p.pos;
  deps.consumeBolt(bolt);
  boltCookoff(c, at);
  if (!deps.cookBoltsNear) return;
  let frontier = deps.cookBoltsNear(at, BOLT_CHAIN_RADIUS);
  for (let pass = 0; pass < BOLT_CHAIN_PASSES && frontier.length; pass++) {
    for (const bp of frontier) boltCookoff(c, bp);
    frontier = deps.cookBoltsNear(frontier[0], BOLT_CHAIN_RADIUS);
  }
}

// Sticky chain: one pop cooks every sibling bomb inside its blast —
// BFS so the detonation ripples outward through spaced bombs.
function chainStickies(c: CombatCtx, src: Projectile): void {
  const deps = c.deps;
  let frontier: Projectile[] = [src];
  for (let pass = 0; pass < 4 && frontier.length; pass++) {
    const next: Projectile[] = [];
    for (const s of frontier) {
      for (const q of deps.world.projectiles) {
        if (!q.config.sticks || q.exploded || q === s) continue;
        if (q.pos.distanceToSquared(s.pos) <= src.config.aoeRadius * src.config.aoeRadius) {
          q.explode();
          next.push(q);
        }
      }
    }
    frontier = next;
  }
}

export function updateProjectiles(c: CombatCtx, dt: number): void {
  const deps = c.deps;
  c.lg.tickBeam(dt); // beam fades ~80ms after the last tick
  prunePendingShots(c);

  const remotePlayerPositions = _remotePlayerPositions;
  remotePlayerPositions.clear();
  deps.world.remotePlayers.forEach((rp, playerId) => {
    if (!rp.isDead) remotePlayerPositions.set(playerId, rp.position);
  });

  // Live turret shells + shield domes — collected once per frame, swept
  // inside each projectile's own collision pass (no tunneling).
  const obstacles = deps.turretBolts?.() ?? [];
  const shields = deps.shieldObstacles?.();
  if (shields?.length) obstacles.push(...shields);

  for (let i = deps.world.projectiles.length - 1; i >= 0; i--) {
    const p = deps.world.projectiles[i];
    p.update(dt, deps.lazyTerrain(), deps.targets, remotePlayerPositions, obstacles);

    collectBoltIntercept(c, p);

    if (p.exploded && !p.explosionProcessed) {
      p.explosionProcessed = true;
      handleProjectileImpact(c, p);
      if (p.config.sticks) chainStickies(c, p);
    }

    if (p.dead) {
      const demoManager = deps.lazyDemoManager();
      if (demoManager?.isRecording && p.demoProjectileId) {
        demoManager.recordProjectileDestroyed(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z });
      }
      p.dispose();
      deps.world.projectiles.splice(i, 1);
    }
  }
}

// A cooked turret shell: its payload detonating where it was shot down.
// No sendAOE — remote-player damage from a cookoff stays unclaimed (it's
// environment-adjacent), but the blast still shoves/kills client-run
// targets including the turret that lobbed it.
function boltCookoff(c: CombatCtx, pos: THREE.Vector3): void {
  processProjectileExplosion(c, {
    pos, radius: BOLT_MEGA_RADIUS, force: BOLT_MEGA_FORCE, forceMode: 'push',
    aoeDamage: BOLT_MEGA_DAMAGE,
    falloffMultiplier: 1, collisionMultiplier: 1, forceMultiplier: 1,
    directHit: true, explosionTint: 0xffaa44, vfxRadius: BOLT_MEGA_RADIUS,
  });
}
