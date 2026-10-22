/**
 * combat/projectiles — the per-frame projectile pipeline: explosion
 * processing (blast fx, force, armor nades, AOE claims), pending-shot
 * prune, turret-bolt interceptions, sticky chain detonations, and the
 * update loop itself. combat.ts keeps deps + factory wiring.
 */
import * as THREE from 'three';
import type { Projectile } from '../../projectiles/Projectile.js';
import type { Targetable } from '../../entities/balls.js';
import { ballGhostPos } from '../../projectiles/sweep.js';
import { getProjectileConfig } from '../../projectiles/index.js';
import { setRibbonCamera, RibbonTrail } from '../../effects/RibbonTrail.js';
import { sweepSmear } from '../../effects/trailBatch.js';
import { Explosion } from '../../effects/explosion.js';
import { AoeGizmo } from '../../effects/aoeGizmo.js';
import { Implosion } from '../../effects/implosion.js';
import { ScorchDecal } from '../../effects/scorch.js';
import * as sfx from '../../core/sfx.js';
import { screenShake } from '../../effects/screenShake.js';
import { EXPLOSION_VFX_RADIUS, SCORCH_MAX } from '../../core/config.js';
import { urlParams } from '../../core/params.js';
import { getWeaponStats, WeaponType, AOE_VFX_SCALE, ARMORNADE_ARMOR, RIDE_CATCH_R, canHostRide } from '../../../../shared/weapons.js';
import { POWERUP } from '../../../../shared/pickups.js';
import { handleProjectileImpact } from './impact.js';
import type { CombatCtx, ExplosionArgs } from '../combat.js';

// Turret-bolt interception: clip a lobbed shell with an explosive and it
// cooks off mid-air — huge blast (the shell's own payload going off), so
// shooting the bolt down NEXT to its turret is a real counterattack.
const BOLT_MEGA_RADIUS = 13;     // bolt's land-splash is ~5m — cookoff is way bigger
const BOLT_MEGA_DAMAGE = 60;
const BOLT_MEGA_FORCE = 55;
const BOLT_CHAIN_RADIUS = 8;     // cookoff blast pops neighboring shells too
const BOLT_CHAIN_PASSES = 3;       // bounded worklist — a chain can't run away

// ?debug / menu DEBUG — show the real gameplay blast radius as a wireframe
// sphere on every detonation (the dome VFX is only 80% of it by design).
// Read live per blast — the menu toggle applies without a reload.
const aoeDebug = (): boolean => urlParams.debug;

const _ropeAnchor = new THREE.Vector3();
// Remote player positions for projectile collision — rebuilt per frame into
// the same Map (zeroed allocations in the hot loop)
const _remotePlayerPositions = new Map<string, THREE.Vector3>();
// Reusable vectors keyed by playerId — remotePlayerPositions is rebuilt
// every frame, so pooled vec refs keep the hot path alloc-free.
const _projVecs = new Map<string, THREE.Vector3>();
// Parallel armor-class map — the sweep needs each body's capsule size.
const _remotePlayerClasses = new Map<string, string>();

// ---- Projectile explosion processing (push or pull based on config) ----
// VFX radius is decoupled from gameplay radius — aoeRadius intentionally
// exceeds the visual dome so damage covers the shock ring, not just the dome.
// Blast presentation layer: explosion/implosion entity, positional audio,
// screenshake, and the terrain scorch decal. All visuals, no gameplay.
function blastFx(c: CombatCtx, a: ExplosionArgs): void {
  // Crumble weapons (bombard) present their shard burst via the impact path
  // (spawnCrumbleShards) — the blast presenter draws no dome, no boom
  // voice, no screenshake and no scorch for them.
  if (a.crumbles) {return;}
  const {deps} = c;
  const { pos, radius, forceMode } = a;
  const directHit = a.directHit ?? false;
  const vfx = a.vfxRadius ?? radius;
  // Impact VFX variant — config-driven (sprinkler splashes, doesn't burn)
  const vfxKind = a.vfx ?? (a.weaponType === undefined ? undefined : getProjectileConfig(a.weaponType)?.vfx);
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
  if (aoeDebug()) {deps.world.aoeGizmos.push(new AoeGizmo(deps.lazyScene(), pos, radius));}
}

export function processProjectileExplosion(c: CombatCtx, a: ExplosionArgs): void {
  const {deps} = c;
  const { pos, radius, force, forceMode, aoeDamage } = a;
  blastFx(c, a);

  // Record explosion for death impulse calculation
  deps.explosionTracker.addExplosion(pos, force, a.shooterId || deps.lazyNetworkManager().getLocalPlayerId());

  if (a.claimLegal !== false) {
    c.applyExplosionForce({ pos, radius, force, forceMode, forceMultiplier: a.forceMultiplier, aoeDamage, directHitTargetId: a.directHitTargetId ?? null, weaponType: a.weaponType, shooterId: a.shooterId, air: a.air, shotId: a.shotId });
  }

  // Armor grenade: predict the plating the server grants so the HUD armor
  // jumps with the blast, not on the next tick. Enemy plating stays
  // server-side — we never predict another player's armor pool.
  if (a.weaponType === WeaponType.ArmorGrenade && a.claimLegal !== false) {
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
  const {deps} = c;
  const stats = getWeaponStats(WeaponType.Slam);
  // Blast scales with landing speed: the skill spikes you at 55 m/s, so a
  // tap-slam lands ~55 and a full dive can exceed 100. ~0.2 at a lazy hop
  // floor, 1.8 max on a huge fall. Server applies the same power factor.
  const power = Math.min(Math.max((impactSpeed - 30) / 50, 0.2), 1.8);
  const networkManager = deps.lazyNetworkManager();
  // Connected: the slam intent replaces the aoeShot claim — the server
  // derives power from its own velocity shadow and runs the blast.
  const sendAOE = networkManager.authorityShells()
    ? undefined
    : (p: { x: number; y: number; z: number }, _targetId: string | null): void =>
      networkManager.sendAOEShot({ position: p, weaponType: WeaponType.Slam, excludeTargetId: _targetId, power });
  if (networkManager.isConnected()) {networkManager.sendSlam({ x: pos.x, y: pos.y, z: pos.z });}
  processProjectileExplosion(c, {
    pos,
    radius: stats.aoeRadius * power * deps.lazyPlayer().mods.aoeRadius,
    force: stats.knockbackForce * power,
    forceMode: stats.forceMode,
    aoeDamage: stats.aoeDamage * power,
    forceMultiplier: 1,
    // no directHit — slam has no proxy-hit bonus layer
    sendAOE,
    explosionTint: 0xFF_CC_66,               // hot slam flash
    vfxRadius: stats.aoeRadius * power * AOE_VFX_SCALE, // VFX = 80% of damage reach
  });
}

// ---- Update projectiles ----
// Dead shells drop their nonce index entry — the map is the only link
// between a live shell and its wire identity; leaking it grows forever.
function pruneShots(c: CombatCtx): void {
  const registry = c.deps.world.projectileRegistry;
  for (const [sid, p] of registry.byShotId) {
    if (p.dead) {registry.byShotId.delete(sid);}
  }
  // byId normally evicts on the destroy echo — a lost projectileDestroyed
  // would keep a dead shell's server-id entry forever otherwise.
  for (const [id, p] of registry.byId) {
    if (p.dead) {registry.byId.delete(id);}
  }
  for (const [slot, p] of registry.byFanSlot) {
    if (p.dead) {registry.byFanSlot.delete(slot);}
  }
}

// A cooked turret shell: its payload detonating where it was shot down.
// No sendAOE — remote-player damage from a cookoff stays unclaimed (it's
// environment-adjacent), but the blast still shoves/kills client-run
// targets including the turret that lobbed it.
function boltCookoff(c: CombatCtx, pos: THREE.Vector3, shooterId?: string): void {
  processProjectileExplosion(c, {
    pos, radius: BOLT_MEGA_RADIUS, force: BOLT_MEGA_FORCE, forceMode: 'push',
    aoeDamage: BOLT_MEGA_DAMAGE,
    forceMultiplier: 1,
    directHit: true, explosionTint: 0xFF_AA_44, vfxRadius: BOLT_MEGA_RADIUS,
    shooterId, // a bot's interception reads as the bot's blast, not mine
  });
}



// Mid-air interception: the projectile's sweep tagged a turret shell —
// cook it at the exact swept contact, then ripple the mega blast through
// neighboring shells with a bounded worklist (no infinite chain).
function collectBoltIntercept(c: CombatCtx, p: Projectile): void {
  const {deps} = c;
  if (!p.hitBolt || !deps.consumeBolt) {return;}
  const bolt = p.hitBolt;
  // Consume once — an exploded projectile lives on until its trail fades,
  // and an uncleared hitBolt would re-fire the mega blast every frame.
  p.hitBolt = null;
  const at = p.hitPointValid ? p.hitPoint : p.pos;
  deps.consumeBolt(bolt);
  boltCookoff(c, at, p.shooterId ?? undefined);
  if (!deps.cookBoltsNear) {return;}
  let frontier = deps.cookBoltsNear(at, BOLT_CHAIN_RADIUS);
  for (let pass = 0; pass < BOLT_CHAIN_PASSES && frontier.length > 0; pass += 1) {
    for (const bp of frontier) {boltCookoff(c, bp, p.shooterId ?? undefined);}
    frontier = deps.cookBoltsNear(frontier[0], BOLT_CHAIN_RADIUS);
  }
}

// Sticky chain: one pop cooks every sibling bomb inside its blast —
// BFS so the detonation ripples outward through spaced bombs.
function chainStickies(c: CombatCtx, src: Projectile): void {
  const {deps} = c;
  let frontier: Projectile[] = [src];
  for (let pass = 0; pass < 4 && frontier.length > 0; pass += 1) {
    const next: Projectile[] = [];
    for (const s of frontier) {
      for (const q of deps.world.projectiles) {
        if (!q.config.sticks || q.exploded || q === s) {continue;}
        if (q.pos.distanceToSquared(s.pos) <= src.config.aoeRadius * src.config.aoeRadius) {
          q.explode();
          next.push(q);
        }
      }
    }
    frontier = next;
  }
}

// Demo-replay bookkeeping rides on disposal so a recorded shot's destroy
// event lands in the clip before its meshes leave the scene.
function retireProjectile(deps: CombatCtx['deps'], p: Projectile, i: number): void {
  const demoManager = deps.lazyDemoManager();
  if (demoManager?.isRecording && p.demoProjectileId) {
    demoManager.recordProjectileDestroyed(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z });
  }
  p.dispose();
  deps.world.projectiles.splice(i, 1);
}


// Rope dart: the thrower→dart line draws every live frame, then stays up
// through the reel — the moving end sliding along the taut rope IS the
// pull animation (terrain anchor fixed / victim tracked on body hits).
// Dead thrower (dropped from the positions map) = a snapped line. Chest
// anchor, not eye — an eye-mounted rope starts inside the shooter's own
// camera and reads as "not attached to anything".
function tickHookRope(deps: CombatCtx['deps'], p: Projectile, remotePositions: Map<string, THREE.Vector3>): void {
  const from = p.shooterId ? remotePositions.get(p.shooterId) : deps.lazyPlayer().pos;
  if (!from || !p.ropeActive) { p.hideRope(); return; }
  // Body connect: the rope end rides the victim — they're the thing
  // being reeled.
  if (p.ropeTo && p.hitPlayerId) {
    const vpos = p.hitPlayerId === 'local' ? deps.lazyPlayer().pos
      : remotePositions.get(p.hitPlayerId);
    if (vpos) {p.ropeTo.copy(vpos);}
  }
  _ropeAnchor.copy(from); _ropeAnchor.y -= 0.7; p.setRope(_ropeAnchor);
}

function catchRiders(list: Projectile[]): void {
  const r2 = RIDE_CATCH_R * RIDE_CATCH_R;
  for (const q of list) {
    if (!q.config.rides || q.host || q.exploded || q.stuck || q.dead) {continue;}
    for (const h of list) {
      if (h === q || h.exploded || h.dead || h.stuck || h.config.rides || h.shooterId !== q.shooterId
        || !canHostRide(h.config.weaponType, getWeaponStats(h.config.weaponType)!)) {continue;}
      if (distSqToSegment(q.pos, h.prevPos, h.pos) <= r2) { q.host = h; break; }
    }
  }
}



export function updateProjectiles(c: CombatCtx, dt: number): void {
  const {deps} = c;
  c.lg.tickBeam(dt); // beam fades ~80ms after the last tick
  pruneShots(c);

  const remotePlayerPositions = _remotePlayerPositions;
  remotePlayerPositions.clear();
  const remotePlayerClasses = _remotePlayerClasses;
  remotePlayerClasses.clear();
  const now = Date.now();
  let maxRenderDelayMs = 0;
  deps.world.remotePlayers.forEach((rp, playerId): void => {
    if (rp.isDead) {return;}
    // Server adjudicates this shell against the victim's wire-fresh pos —
    // sweeping the rendered body (~150ms interp-stale) ghosts hits on
    // fast movers (the replica pops on the stale visual, server shell
    // sails past the real body = dmg-echo's offM class). Project wire
    // pos forward by wire age — the same epoch the authority sees.
    if (rp.lastUpdateTime > 0) {
      const age = Math.min((now - rp.lastUpdateTime) / 1000, 1);
      // The server's ghost rewind judges the victim ~0.7·renderDelay
      // behind live (ghostBack = 0.7·(transit + renderLag)) — wire-fresh
      // overshoots it whole, rendered trails it by the other 30%.
      const ghostLag = Math.min(0.7 * rp.renderDelayMs / 1000, age);
      remotePlayerPositions.set(playerId,
        (_projVecs.get(playerId) ?? _projVecs.set(playerId, new THREE.Vector3()).get(playerId)!)
          .copy(rp.wirePosition).addScaledVector(rp.vel, age - ghostLag));
    } else {
      remotePlayerPositions.set(playerId, rp.position);
    }
    if (rp.armorClass) {remotePlayerClasses.set(playerId, rp.armorClass);}
    if (rp.renderDelayMs > maxRenderDelayMs) {maxRenderDelayMs = rp.renderDelayMs;}
  });

  // Creature ghosts: server creatureSweep rewinds ball/crawler positions
  // by shooterTransit + renderLag (full lag — no 0.7 player advantage), so
  // the authority judges them ~0.1-0.2s behind where the replay-live
  // replica sits. Net-driven targets only — offline balls are local sims.
  const creatureLag = Math.min(0.5, (deps.lazyNetworkManager?.()?.getPing?.() ?? 0) / 2000 + maxRenderDelayMs / 1000);
  for (const k of ballGhostPos.keys()) {if (!deps.targets.includes(k) || k.dead) {ballGhostPos.delete(k);}}
  if (creatureLag > 0) {
    for (const ball of deps.targets) {
      if (!ball.netDriven || ball.dead) {continue;}
      (ballGhostPos.get(ball) ?? ballGhostPos.set(ball, new THREE.Vector3()).get(ball)!)
        .copy(ball.pos).addScaledVector(ball.vel, -creatureLag);
    }
  } else {ballGhostPos.clear();}

  // Live turret shells + shield domes — collected once per frame, swept
  // inside each projectile's own collision pass (no tunneling).
  const obstacles = deps.turretBolts?.() ?? [];
  const shields = deps.shieldObstacles?.();
  if (shields?.length) {obstacles.push(...shields);}

  // Billboard ribbons re-side against this each frame — without it the
  // strip stays locked to its spawn-plane and level shots read edge-on.
  setRibbonCamera(deps.lazyCamera()?.position ?? null);
  // GPU-side leak reaper: any ribbon slot left lit without a live owner
  // (a path that skipped releaseSlot) gets blacked out before it can sit
  // as a frozen streak — the count surfaces in the Alt+Q dump.
  RibbonTrail.sweepLit();
  sweepSmear();
  // Owner-side counterpart of sweepLit: a done ribbon nobody updates any
  // more (orphan path that skipped dispose) still holds its slot + liveSet
  // entry forever — reclaim it so the pool and census reflect reality.
  RibbonTrail.sweepStale();
  for (let i = deps.world.projectiles.length - 1; i >= 0; i -= 1) {
    const p = deps.world.projectiles[i];
    p.update(dt, deps.lazyTerrain(), deps.targets, remotePlayerPositions, obstacles, remotePlayerClasses);

    if (p.config.hook) {tickHookRope(deps, p, remotePlayerPositions);}

    collectBoltIntercept(c, p);

    if (p.exploded && !p.explosionProcessed) {
      p.explosionProcessed = true;
      handleProjectileImpact(c, p);
      if (p.config.sticks) {chainStickies(c, p);}
    }

    if (p.dead) {retireProjectile(deps, p, i);}
  }
  catchRiders(deps.world.projectiles);
}

// Belt-sticky combo: an airborne belt sticky inside a same-owner shell's
// swept segment is swallowed dead-center and rides it (the Painkiller
// stake+grenade trick — lob the bomb, shoot THROUGH it). Same-owner only:
// stealing an enemy's bomb mid-air would be chaos, catching your own is
// the skill shot. Server runs the identical pass — replicas unride on the
// projRide edge, so prediction and authority attach on the same tick.
const _segAB = new THREE.Vector3();
const _segAP = new THREE.Vector3();
function distSqToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _segAB.subVectors(b, a);
  _segAP.subVectors(p, a);
  const d = _segAB.lengthSq();
  const t = d > 0 ? Math.max(0, Math.min(1, _segAP.dot(_segAB) / d)) : 0;
  return _segAP.addScaledVector(_segAB, -t).lengthSq();
}
