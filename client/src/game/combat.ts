// Combat pipeline: weapon fire -> projectile spawn -> per-frame update ->
// impact handling (effects, AOE force, hit scoring, server/demo notifications).
// All shared game state arrives via CombatDeps (getters for late-init objects).

import type * as THREE from 'three';
import type { ViewModel } from '../entities/ViewModel.js';
import type { Ball , Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { SweepObstacle } from '../projectiles/Projectile.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { setupInputTracking } from '../utils/InputTracking.js';
import { createFire } from './combat/fire.js';
import type { WeaponDef } from '../weapons.js';
import type { FireEvent } from '../entities/Player.js';
import { createBlastForce } from './blastForce.js';
import { createLightning } from './combat/lightning.js';
import { createShocklance } from './combat/shocklance.js';
import { createRepair } from './combat/repair.js';
import { createHealBeam } from './combat/healbeam.js';
import { hitTargetLocal, onTargetDestroyed } from './combat/impact.js';
import { processProjectileExplosion, slam, updateProjectiles } from './combat/projectiles.js';
import { WeaponType } from '../../../shared/weapons.js';
import { classCanFire } from '../../../shared/botClasses.js';

import type { GameContext } from './context.js';
import type { Deployables } from './deployables.js';
import type { SpeedLines } from '../effects/speedLines.js';

export interface CombatDeps extends GameContext {
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyViewModel(): ViewModel | undefined;
  lazyHealthBarSystem(): HealthBarSystem;
  lazyDamageNumbers(): DamageNumberManager;
  /** Deployable registry - the repair beam's heal targets live here. */
  lazyDeployables?: () => Deployables;
  /** Optional - melee swing whoosh rides the speed-lines surge path. */
  lazySpeedLines?: () => SpeedLines;
  fragMessages: FragMessages;
  inputTracking: ReturnType<typeof setupInputTracking>;
  explosionTracker: ExplosionTracker;
  // Shootable turret shells: the live bolt list for the projectile sweep,
  // removal of an intercepted bolt, and chain-cookoff of bolts caught in
  // a mega blast. Entities owns the bolt storage, combat owns the check.
  turretBolts?: () => SweepObstacle[];
  /** Shield domes - hostile shells detonate on the field (deployables). */
  shieldObstacles?: () => SweepObstacle[];
  consumeBolt?: (bolt: SweepObstacle) => void;
  cookBoltsNear?: (pos: THREE.Vector3, radius: number) => THREE.Vector3[];
  // Damage → aggro: feed each creature's threat table so shared-PvE
  // targeting picks shooters, not just whoever stands nearest.
  reportTargetDamage?: (target: object, amount: number, attackerId?: string) => void;
  /** Nugget Wars local authority: a hit on a `bot:*` id resolves HERE
   *  (no server to claim to). Returns true when it consumed the hit -
   *  callers then skip the predictDamage/sendShot path. */
  botHit?: (playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId?: string, weaponType?: number, air?: number) => boolean;
  /** A creature died by local hands - DM scoring credits the killer
   *  ('local' when unset; offline bot shells carry their bot id). */
  onCreatureKilled?: (shooterId?: string) => void;
  balls: Ball[];
  targets: Targetable[]; // balls + crawlers - shootable/blastable
  nuggets: Nugget[];
}

export type FireArgs = { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3; bloomRadius?: number; bloomSeq?: number };

/** One explosion call - named args beat the old 15-positional-param
 *  signature where every call site had to comment which holes were empty. */
export interface ExplosionArgs {
  pos: THREE.Vector3;
  radius: number;
  force: number;
  forceMode: 'push' | 'pull';
  aoeDamage: number;
  forceMultiplier: number;
  shooterId?: string;
  directHit?: boolean;
  directHitTargetId?: string | null;
  age?: number;
  sendAOE?: (pos: { x: number; y: number; z: number }, targetId: string | null) => void;
  explosionTint?: string | number;
  /** Decoupled from gameplay `radius` - damage covers the shock ring. */
  vfxRadius?: number;
  /** Impact VFX override ('splash') - resolved from weaponType when unset. */
  vfx?: 'splash';
  /** Kill attribution - railgun refunds its cooldown. */
  weaponType?: number;
  /** Shell's flight time - offline kill-feed `[1.3s]` tag. */
  air?: number;
  /** Detonating shell's nonce - lets blastForce stamp splash predictions
   *  against the shell-fate ledger like direct hits already do. */
  shotId?: string | null;
  /** Shared-validator pre-flight of this blast's aoeShot claim - false
   *  means the server will reject it, so nothing the claim pays for
   *  (remote damage/knockback, self splash, plating) may be predicted. */
  claimLegal?: boolean;
  /** Crumble weapons (bombard): the impact path already spawned the rock
   *  shards - the blast presenter draws no dome, voice, shake or scorch,
   *  but still runs the force/splash. */
  crumbles?: boolean;
}

export interface CombatCtx {
  deps: CombatDeps;
  applyExplosionForce: ReturnType<typeof createBlastForce>['applyExplosionForce'];
  /** Local-body shove prediction only - remote blasts use this so the
   *  wire knockback dedupes against a stamp instead of landing raw. */
  predictLocalShove: ReturnType<typeof createBlastForce>['predictLocalShove'];
  /** Remote-authored blasts shove replayed prey sims too - without this
   *  enemy explosions left client ball/nugget replays ballistic until the
   *  next segment re-anchor (the 15-30m rubberband bursts). */
  applyForceToPrey: ReturnType<typeof createBlastForce>['applyForceToPrey'];
  lg: { tickBeam: (dt: number) => void };
  chainRamp: Map<number, { t: number; n: number }>;
}

// impact.ts reached in for the shared explosion pipeline - keep the old
// import path alive so the re-point is one line here, not churn there.
export { processProjectileExplosion } from './combat/projectiles.js';

export function createCombat(deps: CombatDeps) {

  // Push/pull force on player/creatures/nuggets/remotes + splash damage -
  // game/blastForce.ts. Built first: fire + lightning hooks take it.
  const blast = createBlastForce(deps, { onTargetDestroyed: (t, impulse, wt): void => onTargetDestroyed(c, t, impulse, wt) });
  const { applyExplosionForce, applyForceToRemotes, predictLocalShove, applyForceToPrey } = blast;

  // Trigger dispatch lives in combat/fire.ts - it fires whatever the
  // WeaponDef says (kick + projectile or pellet fan). 'beam' kinds route to
  // the lightning module, which owns its own tick/raycast loop.
  const fire = createFire(deps, { onTargetDestroyed: (t, impulse, wt): void => onTargetDestroyed(c, t, impulse, wt), applyForceToRemotes });
  const { onBelt } = fire;

  // Lightning gun (hitscan tick + beam visual + chain fork) lives in
  // combat/lightning.ts - hooks reach back into this module's shared blast
  // path so lgPop runs the identical explosion pipeline.
  const lg = createLightning(deps, {
    processExplosion: (a): void => processProjectileExplosion(c, a),
    onTargetDestroyed: (t, impulse, wt): void => onTargetDestroyed(c, t, impulse, wt),
    applyForceToRemotes,
  });
  const { lightning, updateBeamVisual } = lg;

  // Shocklance - melee-key pull-out zap (combat/shocklance.ts). Same
  // honest ray + beam fade, one shot per cycle, plasma palette.
  const lance = createShocklance(deps, {
    processExplosion: (a): void => processProjectileExplosion(c, a),
    onTargetDestroyed: (t, impulse, wt): void => onTargetDestroyed(c, t, impulse, wt),
    applyForceToRemotes,
  });

  // Repair tool - the technician's hold-out beam (combat/repair.ts).
  // Shares the LG's beam machinery, tinted weld-green.
  const rep = createRepair(deps);

  // Heal beam - the medic's pocket beam (combat/healbeam.ts). Same
  // honest ray as the LG, clinical cyan; heals the teammate it pins.
  const hb = createHealBeam(deps);

  const c: CombatCtx = {
    deps,
    applyExplosionForce,
    predictLocalShove,
    applyForceToPrey,
    lg: { tickBeam: (dt: number): void => { lg.tickBeam(dt); rep.tickBeam(dt); lance.tickBeam(dt); hb.tickBeam(dt); } },
    // Chaingun ramp state: targetId → last hit time + chain count.
    chainRamp: new Map(),
  };


  return {
    onWeaponFire: (def: WeaponDef, e: FireEvent): void => {
      // Class lock is the server's law, not just a loadout-menu filter -
      // any route that shouldered a gated weapon past the menu (gunlab,
      // stale persisted slot, sidearm) must refuse here too, or every
      // spawn + blast claim spam-rejects for the rest of the life.
      if (!deps.lazyPlayer().armory.kitLocked && !classCanFire(deps.lazyPlayer().appliedClass, def.weaponType)) {return;}
      // Hitscan kinds leave no projectile for observers - tell the server
      // so it can relay a cosmetic playerShot (muzzle audio/visual).
      if (def.kind === 'fan' || def.kind === 'beam') {
        deps.lazyNetworkManager()?.sendShotFired({
          weaponType: def.weaponType, dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
          // The eye point the beam left from - the server uses the claim's
          // own origin (bounded to honest reach) instead of estimating.
          pos: { x: e.origin.x, y: e.origin.y, z: e.origin.z },
        });
      }
      if (def.kind === 'beam') {
        if (def.weaponType === WeaponType.Repair) {rep.repair(e);}
        else if (def.weaponType === WeaponType.Shocklance) {lance.lance(e);}
        else if (def.weaponType === WeaponType.HealBeam) {hb.heal(e);}
        else {lightning(e);}
      }
      else {fire.fireWeapon(def, e);}
    },
    onBelt,
    onMelee: fire.onMelee,
    onLightning: lightning,
    slam: (pos: THREE.Vector3, impactSpeed: number): void => slam(c, pos, impactSpeed),
    updateProjectiles: (dt: number, rawDt?: number): void => updateProjectiles(c, dt, rawDt),
    updateBeamVisual: (): void => { updateBeamVisual(); rep.updateBeamVisual(); hb.updateBeamVisual(); },
    hitTargetLocal: (t: Targetable, dmg: number, attackerId?: string): boolean => hitTargetLocal(c, t, dmg, attackerId),
  };
}
