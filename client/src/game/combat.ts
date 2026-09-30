// Combat pipeline: weapon fire -> projectile spawn -> per-frame update ->
// impact handling (effects, AOE force, hit scoring, server/demo notifications).
// All shared game state arrives via CombatDeps (getters for late-init objects).

import * as THREE from 'three';
import type { ViewModel } from '../entities/ViewModel.js';
import type { Ball } from '../entities/balls.js';
import { Nugget } from '../entities/Nugget.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import { Explosion } from '../effects/explosion.js';
import { AoeGizmo } from '../effects/aoeGizmo.js';
import { Implosion } from '../effects/implosion.js';
import { ScorchDecal } from '../effects/scorch.js';
import { Projectile, type SweepObstacle } from '../projectiles/Projectile.js';
import { getProjectileConfig } from '../projectiles/index.js';
import type { FragMessages } from '../ui/FragMessages.js';
import * as sfx from '../core/sfx.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { setupInputTracking } from '../utils/InputTracking.js';
import { createFire } from './combat/fire.js';
import type { WeaponDef } from '../weapons.js';
import type { FireEvent } from '../entities/Player.js';
import { createBlastForce } from './blastForce.js';
import { createLightning } from './combat/lightning.js';
import { createRepair } from './combat/repair.js';
import { handleProjectileImpact, hitTargetLocal, onTargetDestroyed } from './combat/impact.js';
import { PENDING_ROCKET_TIMEOUT, ROCKET_RADIUS } from '../core/config.js';
import { urlParams } from '../core/params.js';
import { getWeaponStats, WeaponType, AOE_VFX_SCALE, ARMORNADE_ARMOR } from '../../../shared/weapons.js';
import { POWERUP } from '../../../shared/pickups.js';

import { screenShake } from '../effects/screenShake.js';
import type { GameContext } from './context.js';

export interface CombatDeps extends GameContext {
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyViewModel(): ViewModel | undefined;
  lazyHealthBarSystem(): HealthBarSystem;
  lazyDamageNumbers(): DamageNumberManager;
  /** Deployable registry — the repair beam's heal targets live here. */
  lazyDeployables?: () => import('./deployables.js').Deployables;
  fragMessages: FragMessages;
  inputTracking: ReturnType<typeof setupInputTracking>;
  explosionTracker: ExplosionTracker;
  // Shootable turret shells: the live bolt list for the projectile sweep,
  // removal of an intercepted bolt, and chain-cookoff of bolts caught in
  // a mega blast. Entities owns the bolt storage, combat owns the check.
  turretBolts?: () => SweepObstacle[];
  /** Shield domes — hostile shells detonate on the field (deployables). */
  shieldObstacles?: () => SweepObstacle[];
  consumeBolt?: (bolt: SweepObstacle) => void;
  cookBoltsNear?: (pos: THREE.Vector3, radius: number) => THREE.Vector3[];
  // Damage → aggro: feed each creature's threat table so shared-PvE
  // targeting picks shooters, not just whoever stands nearest.
  reportTargetDamage?: (target: object, amount: number, attackerId?: string) => void;
  /** Nugget Wars local authority: a hit on a `bot:*` id resolves HERE
   *  (no server to claim to). Returns true when it consumed the hit —
   *  callers then skip the predictDamage/sendShot path. */
  botHit?: (playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId?: string, weaponType?: number) => boolean;
  /** A creature died by local hands — DM scoring credits the killer
   *  ('local' when unset; offline bot shells carry their bot id). */
  onCreatureKilled?: (shooterId?: string) => void;
  balls: Ball[];
  targets: import('../entities/balls.js').Targetable[]; // balls + crawlers — shootable/blastable
  nuggets: Nugget[];
}

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

export type FireArgs = { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 };

/** One explosion call — named args beat the old 15-positional-param
 *  signature where every call site had to comment which holes were empty. */
export interface ExplosionArgs {
  pos: THREE.Vector3;
  radius: number;
  force: number;
  forceMode: 'push' | 'pull';
  aoeDamage: number;
  falloffMultiplier: number;
  collisionMultiplier: number;
  forceMultiplier: number;
  shooterId?: string;
  directHit?: boolean;
  directHitTargetId?: string | null;
  age?: number;
  sendAOE?: (pos: { x: number; y: number; z: number }, targetId: string | null) => void;
  explosionTint?: string | number;
  /** Decoupled from gameplay `radius` — damage covers the shock ring. */
  vfxRadius?: number;
  /** Impact VFX override ('splash') — resolved from weaponType when unset. */
  vfx?: 'splash';
  /** Kill attribution — railgun refunds its cooldown. */
  weaponType?: number;
}

export interface CombatCtx {
  deps: CombatDeps;
  applyExplosionForce: ReturnType<typeof createBlastForce>['applyExplosionForce'];
  lg: { tickBeam: (dt: number) => void };
  chainRamp: Map<number, { t: number; n: number }>;
}

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
    deps.world.explosions.push(new Explosion(deps.lazyScene(), pos, directHit, a.age ?? 0, deps.lazyTerrain(), vfx / ROCKET_RADIUS, a.explosionTint, vfxKind));
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
function slam(c: CombatCtx, pos: THREE.Vector3, impactSpeed: number): void {
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

function updateProjectiles(c: CombatCtx, dt: number): void {
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

export function createCombat(deps: CombatDeps) {

  // Push/pull force on player/creatures/nuggets/remotes + splash damage —
  // game/blastForce.ts. Built first: fire + lightning hooks take it.
  const blast = createBlastForce(deps, { onTargetDestroyed: (t, impulse, wt) => onTargetDestroyed(c, t, impulse, wt) });
  const { applyExplosionForce, applyForceToRemotes } = blast;

  // Trigger dispatch lives in combat/fire.ts — it fires whatever the
  // WeaponDef says (kick + projectile or pellet fan). 'beam' kinds route to
  // the lightning module, which owns its own tick/raycast loop.
  const fire = createFire(deps, { onTargetDestroyed: (t, impulse, wt) => onTargetDestroyed(c, t, impulse, wt), applyForceToRemotes });
  const { onBelt } = fire;

  // Lightning gun (hitscan tick + beam visual + chain fork) lives in
  // combat/lightning.ts — hooks reach back into this module's shared blast
  // path so lgPop runs the identical explosion pipeline.
  const lg = createLightning(deps, {
    processExplosion: (a) => processProjectileExplosion(c, a),
    onTargetDestroyed: (t, impulse, wt) => onTargetDestroyed(c, t, impulse, wt),
    applyForceToRemotes,
  });
  const { lightning, updateBeamVisual } = lg;

  // Repair tool — the technician's hold-out beam (combat/repair.ts).
  // Shares the LG's beam machinery, tinted weld-green.
  const rep = createRepair(deps);

  const c: CombatCtx = {
    deps,
    applyExplosionForce,
    lg: { tickBeam: (dt: number) => { lg.tickBeam(dt); rep.tickBeam(dt); } },
    // Chaingun ramp state: targetId → last hit time + chain count.
    chainRamp: new Map(),
  };


  return {
    onWeaponFire: (def: WeaponDef, e: FireEvent) => {
      // Hitscan kinds leave no projectile for observers — tell the server
      // so it can relay a cosmetic playerShot (muzzle audio/visual).
      if (def.kind === 'fan' || def.kind === 'beam') {
        deps.lazyNetworkManager()?.sendShotFired({
          weaponType: def.weaponType, dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
        });
      }
      if (def.kind === 'beam') {
        if (def.weaponType === WeaponType.Repair) rep.repair(e);
        else lightning(e);
      }
      else fire.fireWeapon(def, e);
    },
    onBelt,
    onMelee: fire.onMelee,
    onLightning: lightning,
    slam: (pos: THREE.Vector3, impactSpeed: number) => slam(c, pos, impactSpeed),
    updateProjectiles: (dt: number) => updateProjectiles(c, dt),
    updateBeamVisual: () => { updateBeamVisual(); rep.updateBeamVisual(); },
    hitTargetLocal: (t: import('../entities/balls.js').Targetable, dmg: number) => hitTargetLocal(c, t, dmg),
  };
}
