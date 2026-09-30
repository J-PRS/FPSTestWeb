/**
 * Impact handling — projectile exploded: effects, AOE claim, cluster pop,
 * ball/player hit resolution, kill pipeline. Split from combat.ts which
 * now only owns fire -> spawn -> per-frame update.
 */
import * as THREE from 'three';
import { Projectile } from '../../projectiles/Projectile.js';
import { BOMBLET_CONFIG, computeAccuracy } from '../../projectiles/index.js';
import { Explosion } from '../../effects/explosion.js';
import { BallDebris } from '../../effects/debris.js';
import { Nugget } from '../../entities/Nugget.js';
import { burstGibs } from '../../entities/swarms.js';
import type { SwarmSlotOwner } from '../../entities/swarm.js';
import { screenShake } from '../../effects/screenShake.js';
import * as sfx from '../../core/sfx.js';
import { ROCKET_RADIUS, CHAINGUN_RATE } from '../../core/config.js';
import { getWeaponStats, WeaponType, directHitAoeBonus } from '../../../../shared/weapons.js';
import { lgDischarge } from './lightning.js';
import { processProjectileExplosion, type CombatCtx } from '../combat.js';

const CHAIN_WINDOW = CHAINGUN_RATE * 1.5;
const CHAIN_RAMP_CAP = 8;
const CHAIN_STAGGER_FORCE = 6.0; // juggles the target, doesn't melt it

const _debrisDir = new THREE.Vector3();
const _bombDir = new THREE.Vector3(); // cluster bomblet scatter
const _bombVel = new THREE.Vector3();

// Projectile exploded: spawn effect, apply AOE, score hits, notify server/demo
export function handleProjectileImpact(c: CombatCtx, p: Projectile): void {
  const deps = c.deps;
  // Remote shells are server-authoritative: render the effect locally,
  // but never report AOE/destroy/hits — that's the shooter's client's job.
  // (GL shells explode on their 2.5s fuse on every observing client.)
  if (p.isRemote) {
    spawnVisualOnly(c, p);
    return;
  }

  spawnImpactEffect(c, p);
  recordProjectileHit(c, p);
  if (p.config.cluster) spawnClusterBomblets(c, p);

  if (p.hitBall) handleBallHit(c, p, p.hitBall);
  if (p.hitPlayerId) handlePlayerHit(c, p, p.hitPlayerId);

  // Destroy LAST — this tombstones the server-tracked id. WS is ordered,
  // so sending it ahead of the aoeShot/shot claims above used to make
  // every blast arrive at a projectile the server no longer knew
  // ("blast with no known projectile" — splash silently never applied).
  if (p.serverProjectileId) {
    deps.lazyNetworkManager().sendProjectileDestroy(p.serverProjectileId);
  }
}

// Visual effect only — no AOE, no damage, no server traffic
export function spawnVisualOnly(c: CombatCtx, p: Projectile): void {
  const deps = c.deps;
  // Prefer the swept hitPoint — on a bounce-fail the integrated pos is
  // already inside the terrain and the blast would render underground
  const pos = p.hitPointValid ? p.hitPoint : p.pos;
  if (p.config.noExplosion) {
    deps.lazyEffects().spawnImpact(pos, p.vel);
    if (!p.hitBall && !p.hitPlayerId) deps.lazyEffects().spawnBulletMark(pos);
    return;
  }
  deps.world.explosions.push(new Explosion(deps.lazyScene(), pos, p.directHit, p.age, deps.lazyTerrain(), p.explosionRadius / ROCKET_RADIUS, p.config.damageColor, p.config.vfx));
  sfx.explosionAt(pos, p.directHit);
}

export function spawnImpactEffect(c: CombatCtx, p: Projectile): void {
  const deps = c.deps;
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
  const sendAOE = p.config.needsServerTracking === false || p.serverProjectileId === null
    // No server id means the shell was fired before we (re)connected —
    // a blast claim can never resolve and only earns a reject warn.
    ? () => {}
    : (pos: { x: number; y: number; z: number }, targetId: string | null) =>
    networkManager.sendAOEShot({
      position: pos, weaponType, excludeTargetId: targetId,
      // hitAge is 0 when the projectile detonated without a swept hit
      // (terrain, fuse) — 0 isn't nullish, so `??` never fell back and
      // claims went out with airtime=0 → reach check rejected them all.
      projectileId: p.serverProjectileId ?? null, airtime: p.hitAge > 0 ? p.hitAge : p.age,
      directHit: p.directHit || undefined,
    });
  processProjectileExplosion(c, {
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
export function spawnClusterBomblets(c: CombatCtx, p: Projectile): void {
  const deps = c.deps;
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
export function recordProjectileHit(c: CombatCtx, p: Projectile): void {
  const deps = c.deps;
  const demoManager = deps.lazyDemoManager();
  if (demoManager?.isRecording && p.demoProjectileId) {
    const targetId = p.hitBall ? p.hitBall.id : (p.hitPlayerId ? 0xFFFF : 0);
    demoManager.recordProjectileHit(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, targetId);
  }
  // CoolShot/auto-clip is MY highlight reel — a bot's air shot isn't mine
  // to bank. Player shells leave shooterId unset; bots carry 'bot:*'.
  if ((p.hitBall || p.hitPlayerId) && !p.shooterId) {
    deps.logger.info(`[CoolShot] ${p.config.displayName} hit ${p.hitBall ? 'ball' : 'player'} airtime=${p.hitAge.toFixed(3)}s dist=${p.hitDistance.toFixed(1)} direct=${p.directHit}`);
    if (demoManager?.isRecording && p.hitAge > 0.2) {
      demoManager.autoClipOnHit(p.hitAge, 0.2);
    }
  }
}

// Score breakdown is an AIRSHOT reward — grounded hits get the plain
// hit marker, not a stat sheet. `airborne` = target's feet >0.6m over
// terrain at the moment of the hit (same threshold the anim code uses).
export function logHitScore(c: CombatCtx, p: Projectile, target: 'ball' | 'player', airborne: boolean): void {
  const deps = c.deps;
  const acc = computeAccuracy(p.hitAccuracy, p.directHit);
  const dist = p.hitDistance;
  const air = p.hitAge;
  const score = Math.round(acc * dist * air);
  deps.logger.info(`[Hit] ${target} direct=${p.directHit} air=${airborne} accRaw=${p.hitAccuracy.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
  if (airborne) deps.fragMessages.showScore(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`, air);
  deps.lazyHud().showHitMarker();
  sfx.hitMarker(p.directHit);
}

// Shared death pipeline for direct hits AND splash kills — debris,
// nuggets, kill credit, elite split. Without this a blast kill would
// silently delete the entity with no payout.
export function onTargetDestroyed(c: CombatCtx, ball: import('../../entities/balls.js').Targetable, impulse?: THREE.Vector3, weaponType?: number, shooterId?: string): void {
  const deps = c.deps;
  // Railgun reward: any kill (direct or its splash) instantly reloads —
  // the "not useless" payoff that turns a slow precision weapon into a
  // chain-kill tool against clusters. Only when the kill is MINE —
  // a bot's railgun shouldn't refund my trigger.
  const mine = !shooterId || shooterId === 'local';
  if (mine && weaponType === WeaponType.Railgun) deps.lazyPlayer().refundWeaponCooldown();
  if (impulse) _debrisDir.copy(impulse).normalize(); else _debrisDir.set(0, 0.5, 0);
  if (!burstGibs(ball as unknown as SwarmSlotOwner, ball.pos, _debrisDir, ball.vel)) {
    deps.world.debrisList.push(new BallDebris(
      deps.lazyScene(), deps.lazyTerrain(), ball.pos,
      ball.color, ball.scale,
      { bodyRadius: ball.radius, impulseDir: _debrisDir, inheritVel: ball.vel, kind: ball.debrisKind, shardGeos: ball.debrisGeos },
    ));
  }
  screenShake.blast(ball.pos, 1.6, deps.lazyPlayer().pos);
  sfx.enemyCue(ball.pos, ball.dieCue ?? 'die');
  // kills++ is personal credit — bot-authored kills still reach the
  // referee via onCreatureKilled(shooterId), just not my counter.
  if (!ball.scoreless) {
    if (mine) deps.lazyPlayer().kills++;
    deps.onCreatureKilled?.(shooterId);
  }
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


/** A non-beam direct hit invests its damage into the victim's banked pop
 *  charge — the rest of the charge stays smoldering, not wasted. */
export function detonateCharge(p: Projectile, ball: import('../../entities/balls.js').Targetable, dmg: number): void {
  if (p.config.weaponType !== WeaponType.Lightning) lgDischarge(ball.id, dmg, ball.pos);
}

/** Wind the chaingun's bank on a hit: at the cap the shot dumps a
 *  stagger shove into the victim and the bank resets for another
 *  wind-up — sustained tracking pays in displacement, not damage. */
export function chaingunBank(c: CombatCtx, p: Projectile, ball: import('../../entities/balls.js').Targetable): void {
  const now = performance.now() / 1000;
  const st = c.chainRamp.get(ball.id);
  const n = st && now - st.t <= CHAIN_WINDOW ? st.n + 1 : 0;
  c.chainRamp.set(ball.id, { t: now, n: n >= CHAIN_RAMP_CAP ? 0 : n });
  if (n >= CHAIN_RAMP_CAP) {
    const dir = _bombDir.copy(p.vel).normalize();
    ball.vel.x += dir.x * CHAIN_STAGGER_FORCE;
    ball.vel.y += CHAIN_STAGGER_FORCE * 0.6;
    ball.vel.z += dir.z * CHAIN_STAGGER_FORCE;
  }
  // Cheap sweep: drop entries past the chain window when the map grows
  if (c.chainRamp.size > 32) {
    for (const [id, s] of c.chainRamp) if (now - s.t > CHAIN_WINDOW) c.chainRamp.delete(id);
  }
}

export function handleBallHit(c: CombatCtx, p: Projectile, ball: import('../../entities/balls.js').Targetable): void {
  const deps = c.deps;
  const dmg = getWeaponStats(p.config.weaponType).directDamage * deps.lazyPlayer().mods.directDamage;
  if (p.config.weaponType === WeaponType.Chaingun) chaingunBank(c, p, ball);
  deps.reportTargetDamage?.(ball, dmg);
  const destroyed = ball.takeDamage(dmg);
  detonateCharge(p, ball, dmg);
  // Numbers + crosshair marker are MY-hit feedback — bot shells carry
  // shooterId and shouldn't fire them (damage itself still applies).
  const mine = !p.shooterId;
  if (mine) deps.lazyDamageNumbers().spawn(ball.pos, Math.round(dmg), p.config.damageColor, deps.lazyCamera());
  if (!destroyed && !ball.hideHealthBar) {
    deps.lazyHealthBarSystem().spawnBall(ball, dmg, ball.health);
  }
  const airborne = ball.pos.y - ball.radius - deps.lazyTerrain().getHeight(ball.pos.x, ball.pos.z) > 0.6;
  if (mine) logHitScore(c, p, 'ball', airborne);
  if (destroyed) onTargetDestroyed(c, ball, p.vel, p.config.weaponType, p.shooterId ?? undefined);

  const demoManager = deps.lazyDemoManager();
  if (demoManager?.isRecording && !destroyed) {
    demoManager.recordTargetHit(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant, ball.health);
  }
}

export function handlePlayerHit(c: CombatCtx, p: Projectile, playerId: string): void {
  const deps = c.deps;
  const targetPlayer = deps.world.remotePlayers.get(playerId);
  const hitPos = targetPlayer ? targetPlayer.position : deps.lazyPlayer().pos;
  const directDamage = getWeaponStats(p.config.weaponType).directDamage * deps.lazyPlayer().mods.directDamage;
  // Personal feedback (numbers/marker/score) is for shells I fired — a
  // bot-authored hit isn't my frag. Player shells leave shooterId unset.
  const mine = !p.shooterId;
  if (mine) deps.lazyDamageNumbers().spawn(hitPos, directDamage, p.config.damageColor, deps.lazyCamera());
  if (deps.botHit?.(playerId, directDamage, p.pos, p.shooterId ?? undefined, p.config.weaponType)) return; // bot authority: real damage, no claim
  if (!mine) return;
  deps.lazyHealthBarSystem().predictDamage(playerId, directDamage);
  const airborne = targetPlayer
    ? targetPlayer.feetY - deps.lazyTerrain().getHeight(hitPos.x, hitPos.z) > 0.6
    : false;
  logHitScore(c, p, 'player', airborne);

  const networkManager = deps.lazyNetworkManager();
  // A bot-authored shell has no business claiming as the local player —
  // server/P2P authority resolves bot damage on its own end.
  if (networkManager && !p.shooterId?.startsWith('bot:')) {
    networkManager.sendShot({
      targetId: playerId,
      position: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      velocity: { x: p.vel.x, y: p.vel.y, z: p.vel.z },
      timestamp: Date.now(), projectileId: p.serverProjectileId,
      weaponType: p.config.weaponType, airtime: p.hitAge,
    });
    deps.logger.info(`[Shot] Sent to server: player=${playerId} proj=${p.serverProjectileId} direct=${p.directHit} air=${p.hitAge.toFixed(2)}s`);
  }
}

/** Nugget Wars bots damaging creatures: the identical funnel a
 *  projectile hit runs — aggro report, damage numbers, kill pipeline.
 *  attackerId set ⇒ not mine: apply damage but skip the floating number
 *  (personal feedback is for damage I dealt). */
export function hitTargetLocal(c: CombatCtx, t: import('../../entities/balls.js').Targetable, dmg: number, attackerId?: string): boolean {
  const deps = c.deps;
  deps.reportTargetDamage?.(t, dmg);
  if (!attackerId || attackerId === 'local') {
    deps.lazyDamageNumbers().spawn(t.pos, Math.round(dmg), '#ffe08a', deps.lazyCamera());
  }
  if (t.takeDamage(dmg)) { onTargetDestroyed(c, t, t.vel, undefined, attackerId); return true; }
  if (!t.hideHealthBar) deps.lazyHealthBarSystem().spawnBall(t, dmg, t.health);
  return false;
}
