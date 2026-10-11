// Blast force application: push/pull on the local player, creatures,
// nuggets, and remote players — plus splash damage numbers/health bars.
// Extracted from combat.ts; the explosion VFX path stays there.

import type * as THREE from 'three';

import { getProjectileConfig } from '../projectiles/index.js';
import { Projectile } from '../projectiles/Projectile.js';
import { aoeImpulse, aoeImpulseT1At, t1Minbox, aoeDamage as aoeDamageOf, KNOCKBACK_SCALE, BLAST_IMPULSE_MAX, SELF_SPLASH_MAX } from '../../../shared/combat.js';
import { getWeaponStats } from '../../../shared/weapons.js';
import { blastOccluded } from '../../../shared/solidWorld.js';
import type { CombatDeps } from './combat.js';
import type { Targetable } from '../entities/balls.js';
import * as sfx from '../core/sfx.js';
import { parityMiss } from './parity.js';
import { targetDemoId } from '../demo/types.js';

export interface BlastForceHooks {
  onTargetDestroyed(t: Targetable, impulse?: THREE.Vector3, weaponType?: number, shooterId?: string): void;
}

interface Forceable {
  pos: THREE.Vector3;
  applyKnockback(from: THREE.Vector3, force: number): void;
  applyPull(to: THREE.Vector3, force: number): void;
}

// Same LOS rule the server applies: a wall between blast and target
// swallows the prediction — keeps the client from flashing knockback/
// damage the funnel will never confirm (then resyncing it back).
const solids = () => Projectile.solidColliders;

const occluded = (pos: THREE.Vector3, target: THREE.Vector3): boolean =>
  solids().length > 0 && blastOccluded(pos, target, solids());

// Splash damage-number color follows the weapon — getProjectileConfig
// looks up by wire weaponType (the array order isn't the enum).
function splashColor(weaponType?: number): string {
  return getProjectileConfig(weaponType ?? 0)?.damageColor ?? '#ffcc66';
}

/** One blast: where it went off, how hard it shoves, what it deals. */
export interface BlastArgs {
  pos: THREE.Vector3;
  radius: number;
  force: number;
  forceMode: 'push' | 'pull';
  forceMultiplier: number;
  aoeDamage: number;
  directHitTargetId: string | null;
  weaponType?: number;
  /** Offline bot shells carry their bot id so splash kills credit right. */
  shooterId?: string;
  /** Shell's flight time at detonation — offline kill-feed `[1.3s]` tag. */
  air?: number;
}

export function createBlastForce(deps: CombatDeps, hooks: BlastForceHooks) {

  // Nuggets are light pickups — blast throws them at a boosted force so
  // explosions visibly scatter loot instead of it hovering through the blast
  function applyForceToNuggets(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull'
  ): void {
    // Predict what the server applies (RoomPickups.knock): the shared
    // aoeImpulse falloff × 0.4 — NOT a.forceMultiplier: the server's
    // pickup knock ignores it, so a 0.4 push multiplier under-threw
    // every gem 2.5x and serverRest snapped it forward (nugrest spam).
    for (const n of deps.nuggets) {
      if (n.dead || n.collected) {continue;}
      const d = n.pos.distanceTo(pos);
      if (d >= radius) {continue;}
      const f = aoeImpulse(force, d, radius) * 0.4;
      if (forceMode === 'push') {n.applyKnockback(pos, f);}
      else {n.applyPull(pos, f);}
    }
  }

  function applyForceToBalls(
    a: BlastArgs,
    applyTo: (t: Forceable, f: number) => void
  ): void {
    const { pos, radius, aoeDamage, weaponType } = a;
    const scales = weaponType === undefined ? undefined : getWeaponStats(weaponType).aoeScales;
    for (const ball of deps.targets) {
      if (ball.dead) {continue;}
      const db = ball.pos.distanceTo(pos);
      const br = ball.hitRadius ?? ball.radius;
      // One envelope for every blast effect — the creature's own body
      // radius still counts (a surface graze is contact, like players).
      const threshold = radius + br;
      if (db >= threshold || occluded(pos, ball.pos)) {continue;}
      applyTo(ball, a.force * a.forceMultiplier);
      // Splash actually hurts enemies — falloff-scaled like players, with
      // the same damage number + health bar feedback as direct hits
      // (without it, splash damage was invisible and read as "no damage").
      const dmg = aoeDamageOf(aoeDamage, db, radius, scales);
      if (dmg < 1) {continue;}
      // Numbers are MY-hit feedback — a bot blast salting a creature
      // shouldn't stamp them under my crosshair (same gate as remotes).
      if (!a.shooterId) {deps.lazyDamageNumbers().spawn(ball.pos, dmg, splashColor(weaponType), deps.lazyCamera());}
      deps.reportTargetDamage?.(ball, dmg);
      // Every connected blast is server-paid: weapon shells detonate in
      // the authority's sim and deployable pops (mines) detonate in
      // tickMine + preySplash — a claim on top would double-pay.
      const splashServerPaid = weaponType !== undefined || deps.lazyNetworkManager?.()?.authoritySims?.() === true;
      if (ball.takeDamage(dmg, { serverPaid: splashServerPaid })) { hooks.onTargetDestroyed(ball, ball.vel, weaponType, a.shooterId); continue; }
      if (!ball.hideHealthBar) {deps.lazyHealthBarSystem().spawnBall(ball, dmg, ball.health);}
      const dm = deps.lazyDemoManager();
      if (dm?.isRecording) {
        dm.recordTargetHit(targetDemoId(ball), { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant, ball.health);
      }
    }
  }

  // Remote players: damage preview + predicted knockback. Prediction mirrors
  // the server's impulse math (T1 surface-distance ramp) and only bridges the
  // ~1 RTT before the victim's real trajectory streams back — RemotePlayer
  // runs it as dead reckoning and clears stale pre-hit snapshots so there's
  // no snap-back when interpolation resumes.
  function applyForceToRemotes(a: BlastArgs): void {
    const { pos, radius, force, forceMode, aoeDamage, directHitTargetId, shooterId, weaponType } = a;
    const scales = weaponType === undefined ? undefined : getWeaponStats(weaponType).aoeScales;
    for (const [playerId, rp] of deps.world.remotePlayers) {
      if (rp.isDead) {continue;}
      // Match server damage exactly: 1 - dist/radius inside radius, 0 outside —
      // knockback uses the same envelope (aoeImpulseT1), so nothing predicts
      // damage or shove the server never applies.
      const dist = rp.position.distanceTo(pos);
      const impulse = Math.min(aoeImpulseT1At(force, pos, rp.position, radius, rp.armorClass) * KNOCKBACK_SCALE, BLAST_IMPULSE_MAX);
      if (impulse <= 0) {continue;}
      if (occluded(pos, rp.position)) {continue;}
      rp.applyPredictedKnockback(pos, impulse, forceMode === 'pull');
      if (playerId === directHitTargetId) {continue;}
      // Hitmarker is personal feedback — a bot's blast (shooterId set)
      // clipping a remote isn't my frag to celebrate.
      if (!a.shooterId) {deps.lazyHud().showHitMarker();}
      const aoeDmg = aoeDamageOf(aoeDamage, dist, radius, scales);
      // Splash on a player/bot shows a number too — direct hits had one
      // (impact.ts) but blast feedback stopped at the hitmarker, so the
      // common "rocket at their feet" read as dealing nothing.
      if (!a.shooterId && aoeDmg >= 1) {
        deps.lazyDamageNumbers().spawn(rp.position, aoeDmg, splashColor(weaponType), deps.lazyCamera());
      }
      if (deps.botHit?.(playerId, aoeDmg, pos, shooterId, a.weaponType, a.air)) {continue;} // local authority resolved it
      deps.lazyHealthBarSystem().predictDamage(playerId, aoeDmg);
    }
  }

  /** Predicted shove for the LOCAL body — shared by authored blasts
   *  (applyExplosionForce) and remote-blast replicas (impact.ts). Returns
   *  true when the player sat inside the envelope — whether this call
   *  applied the impulse or a raced wire echo already spent it. */
  function predictLocalShove(pos: THREE.Vector3, radius: number, force: number, forceMode: 'push' | 'pull', shooterId?: string): boolean {
    const player = deps.lazyPlayer();
    // Ledger the blast itself, not just the shove: when the wire
    // knockback arrives, net/players.ts can tell 'the blast rendered but
    // its envelope math said I was out' from a shove that truly came
    // from nowhere — only the second deserves the anomaly log.
    deps.explosionTracker.addExplosion(pos, force, shooterId ?? 'remote');
    const dpx = player.pos.distanceTo(pos);
    // Knockback reach = damage reach: the blast ends at aoeRadius, same
    // bound the server applies and the ?debug gizmo draws.
    // Spawn shield: the server refuses enemy-blast shove/damage during
    // the window — predicting it anyway flies the protected player until
    // the silent resync snaps them back (the "pushed by wind" report).
    // Self blasts still predict (the server applies those); a friendly's
    // blast suppression is harmless — its wire knockback lands anyway.
    const shielded = shooterId !== undefined && shooterId !== 'local' && performance.now() < player.protectedUntil;
    if (shielded || dpx - t1Minbox(player.appliedClass) >= radius || occluded(pos, player.pos)) {return false;}
    const now = performance.now();
    // Dedup, reverse direction: the knockback echo can beat its blast's
    // replica explode (handlers run on arrival, the predicted shove waits
    // for the next projectile tick). A recorded raw echo at this center
    // means the shove already landed — consume it, don't re-apply.
    const rkb = deps.world.recentKb;
    // Same 700ms horizon as the stamp lifecycle — under drain-burst lag
    // the replica's explode can trail the echo's wire arrival past 400ms,
    // and a stale window double-shoves + strands a false kb-echo stamp.
    // Same 8m + force match as the stamp consume in players.ts — replica
    // explode positions diverge from the server's blast center past 3m.
    const dup = rkb.findIndex((s): boolean => now - s.t < 700 &&
      Math.hypot(s.x - pos.x, s.y - pos.y, s.z - pos.z) < 8 &&
      (s.f === undefined || Math.abs(s.f - force) < 0.5));
    if (dup !== -1) {rkb.splice(dup, 1); return true;}
    const impulse = Math.min(
      aoeImpulseT1At(force, pos, player.pos, radius, player.appliedClass) * KNOCKBACK_SCALE * player.mods.knockbackTaken,
      BLAST_IMPULSE_MAX);
    if (forceMode === 'push') {player.applyKnockback(pos, impulse);}
    else {player.applyPull(pos, impulse);}
    // Stamp the prediction — the server echoes this same shove back as a
    // `knockback` message ~RTT later; net/players.ts consumes the stamp
    // so the blast can't land twice.
    const stamps = deps.world.selfBlastStamps;
    stamps.push({ x: pos.x, y: pos.y, z: pos.z, t: now, by: shooterId, f: Math.round(force * 10) / 10 });
    // Settle older stamps: a predicted self-shove the server never echoed
    // back (~700ms past the 400ms consume window) was rejected server-side —
    // loud parity miss, not a silent expiry.
    for (let i = stamps.length - 1; i >= 0; i -= 1) {
      if (now - stamps[i]!.t > 700) {
        parityMiss('kb-echo', { x: Math.round(stamps[i]!.x), y: Math.round(stamps[i]!.y), z: Math.round(stamps[i]!.z), by: stamps[i]!.by, f: stamps[i]!.f, ageMs: Math.round(now - stamps[i]!.t) });
        stamps.splice(i, 1);
      }
    }
    if (stamps.length > 8) {stamps.shift();}
    return true;
  }

  // Apply push/pull force to local player, balls, and remote players
  function applyExplosionForce(a: BlastArgs): void {
    // NaN center/params make every `d >= radius` compare FALSE — every
    // Forceable resolves the envelope against NaN and eats a NaN dir.
    if (!Number.isFinite(a.pos.x + a.pos.y + a.pos.z + a.radius + a.force)) {return;}
    const { pos, radius, force, forceMode, aoeDamage } = a;
    const scales = a.weaponType === undefined ? undefined : getWeaponStats(a.weaponType).aoeScales;
    const applyTo = (t: Forceable, f: number): void =>
      forceMode === 'push' ? t.applyKnockback(pos, Math.min(f, BLAST_IMPULSE_MAX)) : t.applyPull(pos, Math.min(f, BLAST_IMPULSE_MAX));

    const player = deps.lazyPlayer();
    const dpx = player.pos.distanceTo(pos);
    if (predictLocalShove(pos, radius, force, forceMode, a.shooterId)) {
      // Self-AOE damage: a tiny fraction of what an enemy would take at the
      // same distance — rocket jumps should be viable, not lethal. Faint
      // vignette only, no hurt sound (JP: the grunt is too much for this).
      // A bot-authored blast (shooterId set) is ENEMY fire, not a rocket
      // jump — it deals full falloff damage and reports the bot as attacker.
      // A direct hit already claimed its damage through the impact path
      // (botHit → hurtLocal → envDamage). Remote targets dedupe on
      // directHitTargetId; the local branch didn't — a direct hit claimed
      // direct + splash (double damage, double rate-limit spend).
      // A self direct hit can't go through sendShot — 'local' resolves
      // to nothing server-side, so zeroing this meant shooting your feet
      // cost nothing. My own shell pays the direct amount scaled by
      // selfDamage through the env claim below (the splash pass is
      // skipped so it can't double-pay). An ENEMY shell that direct-hit
      // me is server-paid already — stay silent.
      const selfHit = a.directHitTargetId === 'local';
      const enemyBlast = a.shooterId && a.shooterId !== 'local';
      const selfDmg = selfHit
        ? (enemyBlast ? 0 : aoeDamage * player.mods.selfDamage)
        : enemyBlast
          ? aoeDamageOf(aoeDamage, dpx, radius, scales)
          // A feet-shot launch pays up to SELF_SPLASH_MAX — same rule
          // the server charges bots, so the disc-jump is a real spend
          // for humans too. The perk still shaves it.
          : Math.min(aoeDamageOf(aoeDamage, dpx, radius, scales) + SELF_SPLASH_MAX * (1 - dpx / radius), SELF_SPLASH_MAX) * player.mods.selfDamage;
      if (selfDmg >= 1 && !player.isDead) {
        // Shield soaks self-splash too — the server holds health steady so
        // the only thing to report is the energy burn + its flash.
        if (player.isShielded) {
          player.absorbShieldDamage(selfDmg);
          deps.lazyHud().showShieldDamage(null, selfDmg);
          sfx.shieldHit();
        } else {
          player.lastDamageSource = enemyBlast
            ? `${a.shooterId!.replace('bot:', '')} blast`
            : 'cooked by your own blast'; // suicide reads as suicide, not "a crawler"
          // Own blast: server applies the self-splash now — claiming it
          // too would double-charge. Keep the local flash; yourHealth
          // echo corrects the bar. Enemy blasts still report for credit.
          if (enemyBlast) {deps.lazyNetworkManager()?.sendEnvironmentDamage(selfDmg, a.shooterId ?? undefined);}
          deps.lazyHud().showDamage(null, selfDmg);
        }
      }
    }
    const kbForce = force * KNOCKBACK_SCALE;
    applyForceToBalls(Object.assign({}, a, {force: kbForce}), applyTo);
    applyForceToNuggets(pos, radius, kbForce, forceMode);
    applyForceToRemotes(a);
    // Deployables in the envelope — the offline mirror of the server's
    // applyBlast sweep (connected, remote hurt is a no-op so the call is
    // cheap prediction-side noise; blastRemotes early-outs anyway).
    {
      const wStats = a.weaponType === undefined ? undefined : getWeaponStats(a.weaponType);
      const direct = wStats ? (wStats.directDamage || wStats.aoeDamage) : aoeDamage;
      deps.lazyDeployables?.()?.blastRemotes(pos, direct, aoeDamage, radius, scales, a.weaponType);
    }
  }

  return { applyExplosionForce, applyForceToRemotes, predictLocalShove };
}
