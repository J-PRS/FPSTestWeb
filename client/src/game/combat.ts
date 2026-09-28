// Combat pipeline: weapon fire -> projectile spawn -> per-frame update ->
// impact handling (effects, AOE force, hit scoring, server/demo notifications).
// All shared game state arrives via CombatDeps (getters for late-init objects).

import * as THREE from 'three';
import type { ViewModel } from '../entities/ViewModel.js';
import type { Ball } from '../entities/balls.js';
import { Nugget } from '../entities/Nugget.js';
import { BallDebris } from '../effects/debris.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import { Explosion } from '../effects/explosion.js';
import { AoeGizmo } from '../effects/aoeGizmo.js';
import { Implosion } from '../effects/implosion.js';
import { ScorchDecal } from '../effects/scorch.js';
import { Projectile, type SweepObstacle } from '../projectiles/Projectile.js';
import { computeAccuracy, BOMBLET_CONFIG } from '../projectiles/index.js';
import type { FragMessages } from '../ui/FragMessages.js';
import * as sfx from '../core/sfx.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { setupInputTracking } from '../utils/InputTracking.js';
import { createFire } from './combat/fire.js';
import { createBlastForce } from './blastForce.js';
import { createLightning } from './combat/lightning.js';
import { burstGibs } from '../entities/swarms.js';
import type { SwarmSlotOwner } from '../entities/swarm.js';
import { PENDING_ROCKET_TIMEOUT, ROCKET_RADIUS, CHAINGUN_RATE } from '../core/config.js';
import { urlParams } from '../core/params.js';
import { getWeaponStats, WeaponType, AOE_VFX_SCALE, directHitAoeBonus } from '../../../shared/weapons.js';

import { screenShake } from '../effects/screenShake.js';
import type { GameContext } from './context.js';

export interface CombatDeps extends GameContext {
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyViewModel(): ViewModel | undefined;
  lazyHealthBarSystem(): HealthBarSystem;
  lazyDamageNumbers(): DamageNumberManager;
  fragMessages: FragMessages;
  inputTracking: ReturnType<typeof setupInputTracking>;
  explosionTracker: ExplosionTracker;
  // Shootable turret shells: the live bolt list for the projectile sweep,
  // removal of an intercepted bolt, and chain-cookoff of bolts caught in
  // a mega blast. Entities owns the bolt storage, combat owns the check.
  turretBolts?: () => SweepObstacle[];
  consumeBolt?: (bolt: SweepObstacle) => void;
  cookBoltsNear?: (pos: THREE.Vector3, radius: number) => THREE.Vector3[];
  // Damage → aggro: feed each creature's threat table so shared-PvE
  // targeting picks shooters, not just whoever stands nearest.
  reportTargetDamage?: (target: object, amount: number, attackerId?: string) => void;
  /** Nugget Wars local authority: a hit on a `bot:*` id resolves HERE
   *  (no server to claim to). Returns true when it consumed the hit —
   *  callers then skip the predictDamage/sendShot path. */
  botHit?: (playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId?: string) => boolean;
  /** A creature died by local hands — DM scoring credits 'local'. */
  onCreatureKilled?: () => void;
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

// Chaingun ramp: +1 dmg per consecutive hit on the same target. A hit
// landing within 1.5× the fire rate of the previous hit on that target
// counts as chained (a miss forces the next shot to arrive ≥2× rate, so
// the ramp naturally resets). Caps at +8 — sustained fire doubles damage.
const CHAIN_WINDOW = CHAINGUN_RATE * 1.5;
const CHAIN_RAMP_CAP = 8;

const _debrisDir = new THREE.Vector3();
const _bombDir = new THREE.Vector3(); // cluster bomblet scatter
const _bombVel = new THREE.Vector3();

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
  /** Kill attribution — railgun refunds its cooldown. */
  weaponType?: number;
}

export function createCombat(deps: CombatDeps) {
  const { logger } = deps;

  // Push/pull force on player/creatures/nuggets/remotes + splash damage —
  // game/blastForce.ts. Built first: fire + lightning hooks take it.
  const blast = createBlastForce(deps, { onTargetDestroyed });
  const { applyExplosionForce, applyForceToRemotes } = blast;

  // Trigger handlers (all 13 weapons + melee) live in combat/fire.ts.
  // They only need deps — their destruction/blast callbacks hoist-resolve.
  const fire = createFire(deps, { onTargetDestroyed, applyForceToRemotes });
  const {
    onFire, onBelt, onDiscLauncher, onChaingun, onMortar, onGrenadeLauncher,
    onFlak, onPlasma, onRailgun, onShotgun, onCannon, onRocketLauncher,
    onPistol, onRevolver, onSticky, onPlasmaGun,
  } = fire;

  // Lightning gun (hitscan tick + beam visual + chain fork) lives in
  // combat/lightning.ts — hooks reach back into this module's shared blast
  // path so lgPop runs the identical explosion pipeline.
  const lg = createLightning(deps, {
    processExplosion: processProjectileExplosion,
    onTargetDestroyed,
    applyForceToRemotes,
  });
  const { lightning, updateBeamVisual } = lg;


  // ---- Projectile explosion processing (push or pull based on config) ----
  // VFX radius is decoupled from gameplay radius — aoeRadius intentionally
  // exceeds the visual dome so damage covers the shock ring, not just the dome.
  function processProjectileExplosion(a: ExplosionArgs): void {
    const { pos, radius, force, forceMode, aoeDamage } = a;
    const directHit = a.directHit ?? false;
    const vfx = a.vfxRadius ?? radius;
    // Explosion/implosion visual + scorch decal on the terrain below the blast
    if (forceMode === 'push') {
      deps.world.explosions.push(new Explosion(deps.lazyScene(), pos, directHit, a.age ?? 0, deps.lazyTerrain(), vfx / ROCKET_RADIUS, a.explosionTint));
      sfx.explosionAt(pos, directHit, a.weaponType);
      screenShake.blast(pos, vfx, deps.lazyPlayer().pos);
    } else {
      deps.world.implosions.push(new Implosion(deps.lazyScene(), pos, a.age ?? 0, deps.lazyTerrain()));
      sfx.implosionAt(pos, directHit);
      screenShake.blast(pos, vfx * 0.5, deps.lazyPlayer().pos);
    }
    // Scorch only when the blast is near the ground — a midair hit would
    // otherwise paint a phantom mark on terrain far below.
    if (pos.y - deps.lazyTerrain().getHeight(pos.x, pos.z) <= vfx) {
      if (deps.world.scorches.length >= SCORCH_MAX) {
        deps.world.scorches.shift()!.dispose();
      }
      deps.world.scorches.push(new ScorchDecal(deps.lazyScene(), deps.lazyTerrain(), pos, vfx * 0.6));
    }
    if (AOE_DEBUG) deps.world.aoeGizmos.push(new AoeGizmo(deps.lazyScene(), pos, radius));

    // Record explosion for death impulse calculation
    deps.explosionTracker.addExplosion(pos, force, a.shooterId || deps.lazyNetworkManager().getLocalPlayerId());

    applyExplosionForce(pos, radius, force, forceMode, a.falloffMultiplier, a.collisionMultiplier, a.forceMultiplier, aoeDamage, a.directHitTargetId ?? null, a.weaponType);

    // AOE damage to remote players (server-side authority)
    const networkManager = deps.lazyNetworkManager();
    if (networkManager && networkManager.isConnected() && a.sendAOE) {
      a.sendAOE({ x: pos.x, y: pos.y, z: pos.z }, a.directHitTargetId ?? null);
    }
  }

  // Q-skill Slam landing — the "explosion" is the player hitting terrain.
  // Runs through the same blast path as projectiles so prediction,
  // particles, scorch, and the server aoeShot all behave identically.
  function slam(pos: THREE.Vector3, impactSpeed: number): void {
    const stats = getWeaponStats(WeaponType.Slam);
    // Blast scales with landing speed: the skill spikes you at 55 m/s, so a
    // tap-slam lands ~55 and a full dive can exceed 100. ~0.2 at a lazy hop
    // floor, 1.8 max on a huge fall. Server applies the same power factor.
    const power = Math.min(Math.max((impactSpeed - 30) / 50, 0.2), 1.8);
    const networkManager = deps.lazyNetworkManager();
    const sendAOE = (p: { x: number; y: number; z: number }, targetId: string | null) =>
      networkManager.sendAOEShot({ position: p, weaponType: WeaponType.Slam, excludeTargetId: targetId, power });
    processProjectileExplosion({
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
  function prunePendingShots(): void {
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
  function collectBoltIntercept(p: Projectile): void {
    if (!p.hitBolt || !deps.consumeBolt) return;
    const at = p.hitPointValid ? p.hitPoint : p.pos;
    deps.consumeBolt(p.hitBolt);
    boltCookoff(at);
    if (!deps.cookBoltsNear) return;
    let frontier = deps.cookBoltsNear(at, BOLT_CHAIN_RADIUS);
    for (let pass = 0; pass < BOLT_CHAIN_PASSES && frontier.length; pass++) {
      for (const bp of frontier) boltCookoff(bp);
      frontier = deps.cookBoltsNear(frontier[0], BOLT_CHAIN_RADIUS);
    }
  }

  // Sticky chain: one pop cooks every sibling bomb inside its blast —
  // BFS so the detonation ripples outward through spaced bombs.
  function chainStickies(src: Projectile): void {
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

  function updateProjectiles(dt: number): void {
    lg.tickBeam(dt); // beam fades ~80ms after the last tick
    prunePendingShots();

    const remotePlayerPositions = _remotePlayerPositions;
    remotePlayerPositions.clear();
    deps.world.remotePlayers.forEach((rp, playerId) => {
      if (!rp.isDead) remotePlayerPositions.set(playerId, rp.position);
    });

    // Live turret shells — collected once per frame, swept inside each
    // projectile's own collision pass (segment-vs-segment, no tunneling).
    const bolts = deps.turretBolts?.();

    for (let i = deps.world.projectiles.length - 1; i >= 0; i--) {
      const p = deps.world.projectiles[i];
      p.update(dt, deps.lazyTerrain(), deps.targets, remotePlayerPositions, bolts);

      collectBoltIntercept(p);

      if (p.exploded && !p.explosionProcessed) {
        p.explosionProcessed = true;
        handleProjectileImpact(p);
        if (p.config.sticks) chainStickies(p);
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
  function boltCookoff(pos: THREE.Vector3): void {
    processProjectileExplosion({
      pos, radius: BOLT_MEGA_RADIUS, force: BOLT_MEGA_FORCE, forceMode: 'push',
      aoeDamage: BOLT_MEGA_DAMAGE,
      falloffMultiplier: 1, collisionMultiplier: 1, forceMultiplier: 1,
      directHit: true, explosionTint: 0xffaa44, vfxRadius: BOLT_MEGA_RADIUS,
    });
  }

  // Projectile exploded: spawn effect, apply AOE, score hits, notify server/demo
  function handleProjectileImpact(p: Projectile): void {
    // Remote shells are server-authoritative: render the effect locally,
    // but never report AOE/destroy/hits — that's the shooter's client's job.
    // (GL shells explode on their 2.5s fuse on every observing client.)
    if (p.isRemote) {
      spawnVisualOnly(p);
      return;
    }

    // Notify server to destroy tracked projectile
    if (p.serverProjectileId) {
      deps.lazyNetworkManager().sendProjectileDestroy(p.serverProjectileId);
    }

    spawnImpactEffect(p);
    recordProjectileHit(p);
    if (p.config.cluster) spawnClusterBomblets(p);

    if (p.hitBall) handleBallHit(p, p.hitBall);
    if (p.hitPlayerId) handlePlayerHit(p, p.hitPlayerId);
  }

  // Visual effect only — no AOE, no damage, no server traffic
  function spawnVisualOnly(p: Projectile): void {
    // Prefer the swept hitPoint — on a bounce-fail the integrated pos is
    // already inside the terrain and the blast would render underground
    const pos = p.hitPointValid ? p.hitPoint : p.pos;
    if (p.config.noExplosion) {
      deps.lazyEffects().spawnImpact(pos, p.vel);
      if (!p.hitBall && !p.hitPlayerId) deps.lazyEffects().spawnBulletMark(pos);
      return;
    }
    deps.world.explosions.push(new Explosion(deps.lazyScene(), pos, p.directHit, p.age, deps.lazyTerrain(), p.explosionRadius / ROCKET_RADIUS, p.config.damageColor));
    sfx.explosionAt(pos, p.directHit);
  }

  function spawnImpactEffect(p: Projectile): void {
    if (p.config.noExplosion) {
      // Bullet impact at the exact sweep intersection point (terrain hits
      // use the bisected hitPoint; ball/player hits use pos).
      const hitPos = p.hitPointValid ? p.hitPoint : p.pos;
      deps.lazyEffects().spawnImpact(hitPos, p.vel);
      // Bullet hole on terrain hits only — enemy/player hits already get
      // damage numbers, bars, and spark feedback
      if (!p.hitBall && !p.hitPlayerId) deps.lazyEffects().spawnBulletMark(hitPos);
      return;
    }
    // One AOE message for all weapons — the shared weapon table carries
    // weaponType, server resolves stats from it (no per-weapon message types)
    const networkManager = deps.lazyNetworkManager();
    const weaponType = p.config.weaponType;
    // Canonical launchers bloom on a direct hit — the blast reach AND its
    // VFX dome grow together so the visual never lies about the damage area
    const bloom = p.directHit ? directHitAoeBonus(weaponType) : 1;
    // Untracked client-local children (cluster bomblets) skip the claim —
    // their damage is the server's WeaponStats.cluster scatter, so a claim
    // would just bounce off projectile resolution.
    const sendAOE = p.config.needsServerTracking === false
      ? () => {}
      : (pos: { x: number; y: number; z: number }, targetId: string | null) =>
      networkManager.sendAOEShot({
        position: pos, weaponType, excludeTargetId: targetId,
        projectileId: p.serverProjectileId ?? null, airtime: p.hitAge ?? p.age,
        directHit: p.directHit || undefined,
      });
    processProjectileExplosion({
      pos: p.hitPointValid ? p.hitPoint : p.pos,
      radius: p.config.aoeRadius * bloom * deps.lazyPlayer().mods.aoeRadius,   // gameplay radius = server truth (incl. perk)
      force: p.force,
      forceMode: p.forceMode,
      aoeDamage: p.config.aoeDamage,
      falloffMultiplier: p.config.falloffMultiplier,
      collisionMultiplier: p.config.collisionMultiplier,
      forceMultiplier: p.config.forceMultiplier,
      directHit: p.directHit,
      directHitTargetId: p.hitPlayerId,
      age: p.age,
      sendAOE,
      explosionTint: p.config.damageColor,
      vfxRadius: p.explosionRadius * bloom, // VFX dome grows with the damage area
      weaponType,
    });
  }

  // Cluster pop: scatter bomblets in an upward cone — VISUAL only. Damage
  // comes from the server's WeaponStats.cluster scatter on the carrier's
  // validated blast; client-side pops never claim (untracked projectile).
  function spawnClusterBomblets(p: Projectile): void {
    const { count, spread, fuse } = p.config.cluster!;
    const at = p.hitPointValid ? p.hitPoint : p.pos;
    for (let i = 0; i < count; i++) {
      const yaw = Math.random() * Math.PI * 2;
      const tilt = Math.random() * spread; // 0..spread off straight-up
      _bombDir.set(Math.sin(yaw) * Math.sin(tilt), Math.cos(tilt), Math.cos(yaw) * Math.sin(tilt));
      // Per-instance config clone only carries the jittered fuse —
      // 5 allocations per cluster pop, not a hot path.
      const cfg = { ...BOMBLET_CONFIG, maxLifetime: fuse * (0.6 + Math.random() * 0.8) };
      // Bomblet speed lives in the "playerVel" ctor arg: config.speed is 0 and
      // the ctor adds half the inherit term, so dir × (s × 2) nets dir × s.
      _bombVel.copy(_bombDir).multiplyScalar((9 + Math.random() * 6) * 2);
      const b = new Projectile(deps.lazyScene(), at, _bombDir, _bombVel, cfg);
      deps.world.projectiles.push(b);
    }
  }

  // Demo recording + cool-shot logging for any hit (terrain, ball, or player)
  function recordProjectileHit(p: Projectile): void {
    const demoManager = deps.lazyDemoManager();
    if (demoManager?.isRecording && p.demoProjectileId) {
      const targetId = p.hitBall ? p.hitBall.id : (p.hitPlayerId ? 0xFFFF : 0);
      demoManager.recordProjectileHit(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, targetId);
    }
    if (p.hitBall || p.hitPlayerId) {
      logger.info(`[CoolShot] ${p.config.displayName} hit ${p.hitBall ? 'ball' : 'player'} airtime=${p.hitAge.toFixed(3)}s dist=${p.hitDistance.toFixed(1)} direct=${p.directHit}`);
      if (demoManager?.isRecording && p.hitAge > 0.2) {
        demoManager.autoClipOnHit(p.hitAge, 0.2);
      }
    }
  }

  // Score breakdown is an AIRSHOT reward — grounded hits get the plain
  // hit marker, not a stat sheet. `airborne` = target's feet >0.6m over
  // terrain at the moment of the hit (same threshold the anim code uses).
  function logHitScore(p: Projectile, target: 'ball' | 'player', airborne: boolean): void {
    const acc = computeAccuracy(p.hitAccuracy, p.directHit);
    const dist = p.hitDistance;
    const air = p.hitAge;
    const score = Math.round(acc * dist * air);
    logger.info(`[Hit] ${target} direct=${p.directHit} air=${airborne} accRaw=${p.hitAccuracy.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
    if (airborne) deps.fragMessages.showScore(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`, air);
    deps.lazyHud().showHitMarker();
    sfx.hitMarker(p.directHit);
  }

  // Shared death pipeline for direct hits AND splash kills — debris,
  // nuggets, kill credit, elite split. Without this a blast kill would
  // silently delete the entity with no payout.
  function onTargetDestroyed(ball: import('../entities/balls.js').Targetable, impulse?: THREE.Vector3, weaponType?: number): void {
    // Railgun reward: any kill (direct or its splash) instantly reloads —
    // the "not useless" payoff that turns a slow precision weapon into a
    // chain-kill tool against clusters.
    if (weaponType === WeaponType.Railgun) deps.lazyPlayer().refundWeaponCooldown();
    // Seamless shatter for instanced species: the body's own part
    // instances become the debris at identical transforms — the corpse IS
    // the wreckage on frame 0, no pop to mask. Single-part bodies (balls)
    // fall back to the shell-sampled shard burst.
    if (impulse) _debrisDir.copy(impulse).normalize(); else _debrisDir.set(0, 0.5, 0);
    if (!burstGibs(ball as unknown as SwarmSlotOwner, ball.pos, _debrisDir, ball.vel)) {
      deps.world.debrisList.push(new BallDebris(
        deps.lazyScene(), deps.lazyTerrain(), ball.pos.x, ball.pos.y, ball.pos.z,
        ball.color, ball.scale,
        { bodyRadius: ball.radius, impulseDir: _debrisDir, inheritVel: ball.vel, kind: ball.debrisKind, shardGeos: ball.debrisGeos },
      ));
    }
    screenShake.blast(ball.pos, 1.6, deps.lazyPlayer().pos);
    sfx.enemyCue(ball.pos, ball.dieCue ?? 'die');
    if (!ball.scoreless) { deps.lazyPlayer().kills++; deps.onCreatureKilled?.(); }
    if (!ball.lootless) {
      for (let n = 0; n < Math.round(ball.scale); n++) {
        deps.nuggets.push(new Nugget(deps.lazyScene(), ball.pos, ball.vel));
      }
    }
    ball.onDeath?.(ball); // elite split — entities.ts spawns the children
    // Record here, not in handleBallHit — splash kills need it too
    if (deps.lazyDemoManager()?.isRecording) {
      deps.lazyDemoManager()!.recordTargetDestroyed(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, ball.variant, ball.health);
    }
  }

  // Per-target chaingun ramp state: targetId → last hit time + chain count.
  // Entries prune lazily on write — the map stays small.
  const chainRamp = new Map<number, { t: number; n: number }>();

  function handleBallHit(p: Projectile, ball: import('../entities/balls.js').Targetable): void {
    let dmg = getWeaponStats(p.config.weaponType).directDamage * deps.lazyPlayer().mods.directDamage;
    if (p.config.weaponType === WeaponType.Chaingun) {
      const now = performance.now() / 1000;
      const st = chainRamp.get(ball.id);
      const n = st && now - st.t <= CHAIN_WINDOW ? Math.min(st.n + 1, CHAIN_RAMP_CAP) : 0;
      chainRamp.set(ball.id, { t: now, n });
      dmg += n;
      // Cheap sweep: drop entries past the chain window when the map grows
      if (chainRamp.size > 32) {
        for (const [id, s] of chainRamp) if (now - s.t > CHAIN_WINDOW) chainRamp.delete(id);
      }
    }
    deps.reportTargetDamage?.(ball, dmg);
    const destroyed = ball.takeDamage(dmg);
    deps.lazyDamageNumbers().spawn(ball.pos, Math.round(dmg), p.config.damageColor, deps.lazyCamera());
    if (!destroyed && !ball.hideHealthBar) {
      deps.lazyHealthBarSystem().spawnBall(ball, dmg, ball.health);
    }
    const airborne = ball.pos.y - ball.radius - deps.lazyTerrain().getHeight(ball.pos.x, ball.pos.z) > 0.6;
    logHitScore(p, 'ball', airborne);
    if (destroyed) onTargetDestroyed(ball, p.vel, p.config.weaponType);

    const demoManager = deps.lazyDemoManager();
    if (demoManager?.isRecording && !destroyed) {
      demoManager.recordTargetHit(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant, ball.health);
    }
  }

  function handlePlayerHit(p: Projectile, playerId: string): void {
    const targetPlayer = deps.world.remotePlayers.get(playerId);
    const hitPos = targetPlayer ? targetPlayer.position : deps.lazyPlayer().pos;
    const directDamage = getWeaponStats(p.config.weaponType).directDamage * deps.lazyPlayer().mods.directDamage;
    deps.lazyDamageNumbers().spawn(hitPos, directDamage, p.config.damageColor, deps.lazyCamera());
    if (deps.botHit?.(playerId, directDamage, p.pos)) return; // bot authority: real damage, no claim
    deps.lazyHealthBarSystem().predictDamage(playerId, directDamage);
    const airborne = targetPlayer
      ? targetPlayer.feetY - deps.lazyTerrain().getHeight(hitPos.x, hitPos.z) > 0.6
      : false;
    logHitScore(p, 'player', airborne);

    const networkManager = deps.lazyNetworkManager();
    if (networkManager) {
      networkManager.sendShot({
        targetId: playerId,
        position: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
        velocity: { x: p.vel.x, y: p.vel.y, z: p.vel.z },
        timestamp: Date.now(), projectileId: p.serverProjectileId,
        weaponType: p.config.weaponType, airtime: p.hitAge,
      });
      logger.info(`[Shot] Sent to server: player=${playerId} proj=${p.serverProjectileId} direct=${p.directHit} air=${p.hitAge.toFixed(2)}s`);
    }
  }

  /** Nugget Wars bots damaging creatures: the identical funnel a
   *  projectile hit runs — aggro report, damage numbers, kill pipeline. */
  function hitTargetLocal(t: import('../entities/balls.js').Targetable, dmg: number): boolean {
    deps.reportTargetDamage?.(t, dmg);
    deps.lazyDamageNumbers().spawn(t.pos, Math.round(dmg), '#ffe08a', deps.lazyCamera());
    if (t.takeDamage(dmg)) { onTargetDestroyed(t, t.vel); return true; }
    if (!t.hideHealthBar) deps.lazyHealthBarSystem().spawnBall(t, dmg, t.health);
    return false;
  }

  return {
    onFire, onBelt, onDiscLauncher, onChaingun, onMortar, onGrenadeLauncher, onFlak, onPlasma, onRailgun, onShotgun, onCannon, onRocketLauncher, onPistol, onRevolver, onSticky, onPlasmaGun,
    onMelee: fire.onMelee,
    onLightning: lightning,
    slam,
    updateProjectiles,
    updateBeamVisual,
    hitTargetLocal,
  };
}
