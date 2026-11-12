/**

 * Impact handling - projectile exploded: effects, AOE claim, cluster pop,

 * ball/player hit resolution, kill pipeline. Split from combat.ts which

 * now only owns fire -> spawn -> per-frame update.

 */

import * as THREE from 'three';

import { Projectile } from '../../projectiles/Projectile.js';

import { BOLT_CONFIG, BOMBLET_CONFIG, DISC_CONFIG, computeAccuracy, shotScore } from '../../projectiles/index.js';

import { Explosion } from '../../effects/explosion.js';

import { BallDebris } from '../../effects/debris.js';

import { SplatDecal } from '../../effects/splat.js';

import { Nugget } from '../../entities/Nugget.js';
import { PICKUP_ACCENT, pickupParts } from '../../entities/PickupModel.js';
import { tokenTier } from '../../../../shared/pickups.js';

import { burstGibs } from '../../entities/swarms.js';

import { screenShake } from '../../effects/screenShake.js';

import * as sfx from '../../core/sfx.js';

import { EXPLOSION_VFX_RADIUS, CHAINGUN_RATE, SPLAT_MAX } from '../../core/config.js';

import { WeaponType, directHitAoeBonus, roomDirectDamage, getWeaponStats, serverSimmed, IGUN_AOE_MULT } from '../../../../shared/weapons.js';

import { expectDamageEcho, projWireAt } from '../parity.js';

import { validateAoeClaim, validateHitClaim, type TrackedProjectile, type HitClaimVerdict } from '../../../../shared/combat.js';

import { isBotId } from '../../../../shared/botNames.js';

import { HIT_TARGET_NONE, targetDemoId } from '../../demo/types.js';
import type { DemoManager } from '../../demo/DemoManager.js';

import { lgDischarge } from './lightning.js';

import { AoeGizmo } from '../../effects/aoeGizmo.js';

import { urlParams } from '../../core/params.js';

import { processProjectileExplosion, type CombatCtx, type CombatDeps } from '../combat.js';

import type { Targetable } from '../../entities/balls.js';
import { simRand } from '../../../../shared/simRand.js';

const _splatPos = new THREE.Vector3();
const _claimTarget = new THREE.Vector3();
let _kbWirePos: THREE.Vector3 | undefined;



const CHAIN_WINDOW = CHAINGUN_RATE * 1.5;

const CHAIN_RAMP_CAP = 8;

const CHAIN_STAGGER_FORCE = 6; // juggles the target, doesn't melt it



const _debrisDir = new THREE.Vector3();

const _ichorCol = new THREE.Color();



/** Pre-flight a claim through the SAME validator the server runs - a

 *  verdict of !ok means the claim is dead on arrival, so predicting its

 *  damage (health bars, numbers, remote knockback) would be a ghost hit

 *  and sending it just spends a reject. The server's `projectile` record

 *  is rebuilt from the shell's own launch data: ownerId is unused by the

 *  checks and spawnAt mirrors the spawn-claim stamp on our clock. */

function claimRecord(c: CombatCtx, p: Projectile): TrackedProjectile {

  return {

    ownerId: c.deps.lazyNetworkManager()?.getLocalPlayerId() ?? 'local',

    weaponType: p.config.weaponType,

    origin: p.shotOrigin,

    velocity: p.launchVel,

    spawnAt: p.spawnedAtMs,

    clientShotId: p.shotId ?? undefined,

  };

}



function shooterVel(c: CombatCtx): { x: number; y: number; z: number } {

  const v = c.deps.lazyPlayer().vel;

  return { x: v.x, y: v.y, z: v.z };

}



function aoeVerdict(c: CombatCtx, p: Projectile, pos: { x: number; y: number; z: number }, airtime: number): HitClaimVerdict {

  return validateAoeClaim({

    projectile: claimRecord(c, p), blastPos: pos, airtime,

    shooterVel: shooterVel(c), now: performance.now(), solids: p.solids(),

    shooterTeam: c.deps.world.localTeam,

  });

}



function hitVerdict(c: CombatCtx, p: Projectile, hitPos: { x: number; y: number; z: number }, targetPos: { x: number; y: number; z: number }, airtime: number, targetClass?: string): HitClaimVerdict {

  return validateHitClaim({

    projectile: claimRecord(c, p), hitPos, targetPos, airtime,

    shooterVel: shooterVel(c), now: performance.now(), solids: p.solids(),

    shooterTeam: c.deps.world.localTeam,

    targetClass,

  });

}



function splatAt(c: CombatCtx, x: number, z: number, r: number, hex: number, intensity?: number, dx = 0, dz = 0): void {

  const {deps} = c;

  if (deps.world.splats.length >= SPLAT_MAX) {deps.world.splats.shift()!.dispose();}

  _splatPos.set(x, 0, z);

  // Smear the stain along the droplet's landing velocity - a streaked

  // splash, not a round dot. Slow drops stay roundish pools.

  const sp = Math.hypot(dx, dz);

  const ux = sp > 0.01 ? dx / sp : 0, uz = sp > 0.01 ? dz / sp : 0;

  const stretch = Math.min(sp * 0.18, 1.6);

  deps.world.splats.push(new SplatDecal(

    deps.lazyScene(), deps.lazyTerrain(), _splatPos, r, hex, intensity, ux, uz, stretch,

  ));

}





// Creature hits bleed tinted ichor: a directional droplet spray (rides the

// pooled debris system) + a projected ground stain. Absent on mechanicals

// (Turretter) and props (Tumbleweed) - they leave ichor undefined.

// Droplets paint their own stain where they land (the Wendigo model) -

// a spray arcing over a ridge stains THAT ground, not the shooter's feet.

function ichorSpray(c: CombatCtx, ball: Targetable, dir: THREE.Vector3, scale: number): void {

  if (ball.ichor === undefined) {return;}

  const {deps} = c;

  const hex = ball.ichor;

  deps.world.debrisList.push(new BallDebris(

    deps.lazyScene(), deps.lazyTerrain(), ball.pos,

    _ichorCol.setHex(hex), scale,

    { impulseDir: dir, kind: 'goo', paintBudget: 4,

      onDropletLand: (x, z, r, dx, dz): void => splatAt(c, x, z, r * (4 + Math.random() * 2.5), hex, 0.5, dx, dz) },

  ));

}





function ichorSplat(c: CombatCtx, ball: Targetable, radius: number): void {

  splatAt(c, ball.pos.x, ball.pos.z, radius, ball.ichor!);

}



// Instanced body-part gib burst when the species has one, else the generic

// shard debris - same visual contract either way.

function corpseBurst(c: CombatCtx, ball: Targetable, dir: THREE.Vector3): void {

  if (burstGibs(ball, ball.pos, dir, ball.vel)) {return;}

  c.deps.world.debrisList.push(new BallDebris(

    c.deps.lazyScene(), c.deps.lazyTerrain(), ball.pos,

    ball.color, ball.scale,

    { bodyRadius: ball.radius, impulseDir: dir, inheritVel: ball.vel, kind: ball.debrisKind, shardGeos: ball.debrisGeos },

  ));

}



// The body pops AND the ground keeps the stain - death reads as a wound,

// not a despawn.

function ichorDeath(c: CombatCtx, ball: Targetable, dir: THREE.Vector3): void {

  if (ball.ichor === undefined) {return;}

  ichorSpray(c, ball, dir, 0.55);

  ichorSplat(c, ball, ball.radius * 2.4);

}

const _bombDir = new THREE.Vector3(); // cluster bomblet scatter

const _bombVel = new THREE.Vector3();

const _coneAxis = new THREE.Vector3();

const _coneQuat = new THREE.Quaternion();

const _coneUp = new THREE.Vector3(0, 1, 0);



export function handlePlayerHit(c: CombatCtx, p: Projectile, playerId: string): void {

  const {deps} = c;

  const targetPlayer = deps.world.remotePlayers.get(playerId);

  const hitPos = targetPlayer ? targetPlayer.position : deps.lazyPlayer().pos;

  const directDamage = roomDirectDamage(p.config.weaponType, deps.world.instagib, p.directHit ? p.hitAge : undefined, deps.world.igun) * deps.lazyPlayer().mods.directDamage * (p.directBonus ?? 1);

  // Personal feedback (numbers/marker/score) is for shells I fired - a

  // bot-authored hit isn't my frag. Player shells leave shooterId unset.

  const mine = !p.shooterId;

  // 'local' is a client sentinel - the server can't resolve it, so the

  // claim would only earn a reject. Self-damage reports through the

  // blast's env-damage channel instead (blastForce handles it once).

  const willClaim = playerId !== 'local'

    && deps.lazyNetworkManager()

    && !(p.shooterId && isBotId(p.shooterId));

  // Same gate as the blast: a hit the shared validator calls illegal is

  // dead on arrival - predicting its damage (numbers, bars, score) is

  // the ghost-hit feedback the reject warn complains about.

  if (mine && willClaim) {

    // The sweep that scored this hit ran on the ghost - the buffer pos at
    // the shooter's view epoch, which is what the server rewinds to.
    // Validating against the rendered `position` suppresses honest claims
    // whenever the two diverge (converge/drift episodes, 6-14m observed).
    // The server's rewind is (victimPing−myPing)/2 shallower than the
    // view ghost - validate at the adjudicated epoch, not the painted one.
    const myTransit = (deps.lazyNetworkManager?.()?.serverPingMs ?? deps.lazyNetworkManager?.()?.getPing?.() ?? 0) / 2;
    const claimTarget = targetPlayer ? targetPlayer.ghostPosition(_claimTarget, myTransit) : hitPos;
    const verdict = hitVerdict(c, p, p.hitPointValid ? p.hitPoint : p.pos, claimTarget, p.hitAge, targetPlayer?.armorClass);

    if (!verdict.ok) {

      deps.logger.info(`[Shot] hit claim suppressed pre-flight: ${verdict.reason}`);

      return;

    }

  }

  if (mine) {deps.lazyDamageNumbers().spawn(hitPos, directDamage, p.config.damageColor, deps.lazyCamera());}

  if (deps.botHit?.(playerId, directDamage, p.pos, p.shooterId ?? undefined, p.config.weaponType, p.hitAge)) {return;} // bot authority: real damage, no claim

  if (!mine) {return;}

  deps.lazyHealthBarSystem().predictDamage(playerId, directDamage);

  // Authority rooms give this hit no claim - stamp it so a server whiff

  // (no playerHit echo within ~RTT) counts as a ghost hit in the dump.

  // P2P/claim rooms already ledger the outcome through claimSeq instead.

  if (deps.lazyNetworkManager()?.authoritySims()) {

    expectDamageEcho(playerId, directDamage, p.config.weaponType, p.pullShotId ?? p.shotId, { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      targetPlayer ? { x: targetPlayer.wirePosition.x, y: targetPlayer.wirePosition.y, z: targetPlayer.wirePosition.z } : undefined);

  }

  const airborne = targetPlayer

    ? targetPlayer.feetY - deps.lazyTerrain().getHeight(hitPos.x, hitPos.z) > 0.6

    : false;

  logHitScore(c, p, 'player', airborne, playerId);



  if (playerId === 'local') {return;}

  // A predicted server-simmed shell still unbound past the bind grace is

  // a ghost - the authority knows nothing about it and will never pay the

  // damage. Under the grace it's a benign race: close-range hits land

  // before the projectileCreated echo round-trips, while the server-side

  // shell exists and adjudicates its own contact regardless.

  if (serverSimmed(p.config.weaponType) && deps.lazyNetworkManager()?.authorityShells() && !p.serverProjectileId && p.age > 0.6) {

    deps.logger.warn(`[Shot] ghost shell hit ${playerId}: ${p.config.displayName} never bound to a server shell (shotId=${p.shotId}, age=${p.age.toFixed(2)}s) - hit is prediction-only, no damage`);

  }

  // Server-simmed shells never claim their hit - predicted feedback

  // (damage numbers, bars, hitmarker) already ran above; the authority

  // declares the outcome via playerHit/projectileDestroyed.

}





export function handleBallHit(c: CombatCtx, p: Projectile, ball: Targetable): void {

  const {deps} = c;

  // Airtime ramp is body-contact only - wake hits pay flat directDamage.

  const dmg = roomDirectDamage(p.config.weaponType, deps.world.instagib, p.directHit ? p.hitAge : undefined, deps.world.igun) * deps.lazyPlayer().mods.directDamage * (p.directBonus ?? 1);

  if (p.config.weaponType === WeaponType.Chaingun) {chaingunBank(c, p, ball);}

  deps.reportTargetDamage?.(ball, dmg);

  // Shell contact is server-paid - the authority's creatureSweep pays

  // this hit already; a claim would double it (feedback still local).

  const destroyed = ball.takeDamage(dmg, { serverPaid: true });

  detonateCharge(p, ball, dmg);

  // Numbers + crosshair marker are MY-hit feedback - bot shells carry

  // shooterId and shouldn't fire them (damage itself still applies).

  const mine = !p.shooterId;

  if (mine) {deps.lazyDamageNumbers().spawn(ball.pos, Math.round(dmg), p.config.damageColor, deps.lazyCamera());}

  if (!destroyed && !ball.hideHealthBar) {

    deps.lazyHealthBarSystem().spawnBall(ball, dmg, ball.health);

  }

  const airborne = ball.pos.y - ball.radius - deps.lazyTerrain().getHeight(ball.pos.x, ball.pos.z) > 0.6;

  if (mine) {logHitScore(c, p, 'ball', airborne, `ball#${ball.id}`);}

  if (destroyed) {onTargetDestroyed(c, ball, p.vel, p.config.weaponType, p.shooterId ?? undefined);}

  else if (ball.ichor !== undefined) {

    // Non-lethal hit: a thin spray along the shot direction - the stains

    // come free wherever the droplets land (ichorSpray paints them).

    _debrisDir.copy(p.vel).normalize();

    ichorSpray(c, ball, _debrisDir, 0.28);

  }



  const demoManager = deps.lazyDemoManager();

  if (demoManager?.isRecording && !destroyed) {

    demoManager.recordTargetHit(targetDemoId(ball), { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant, ball.health);

  }

}





// Demo recording + cool-shot logging for any hit (terrain, ball, or player)

/** Demo record for a landed shell: targetId is the ball id for ball
 *  hits, 0xFFFF for the anonymous player hit; targetType carries the
 *  ball variant so playback looks the victim up in the right map. */
function recordHitDemo(demoManager: DemoManager | null, p: Projectile): void {
  if (!demoManager?.isRecording || !p.demoProjectileId) {return;}
  let targetId = 0;
  if (p.hitBall) {targetId = p.hitBall.id;}
  else if (p.hitPlayerId) {targetId = 0xFF_FF;}
  const targetType = p.hitBall ? p.hitBall.variant : HIT_TARGET_NONE;
  demoManager.recordProjectileHit(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, targetId, p.config.weaponType, targetType);
}

export function recordProjectileHit(c: CombatCtx, p: Projectile): void {

  const {deps} = c;

  const demoManager = deps.lazyDemoManager();

  recordHitDemo(demoManager, p);

  // CoolShot/auto-clip is MY highlight reel - a bot's air shot isn't mine

  // to bank. Player shells leave shooterId unset; bots carry 'bot:*'.

  // demoProjectileId is the hard lane check: only locally-fired shells
  // carry one (remote/deploy/bot shells go through the serverId lane and
  // never set it), so !shooterId alone can't be bypassed by a spawn path
  // that forgot to stamp ownership.
  if ((p.hitBall || p.hitPlayerId) && !p.shooterId && p.demoProjectileId) {

    const hitWho = p.hitBall ? `ball#${p.hitBall.id}` : (p.hitPlayerId ?? '?');

    deps.logger.info(`[CoolShot] ${p.config.displayName} hit ${hitWho} airtime=${p.hitAge.toFixed(3)}s dist=${p.hitDistance.toFixed(1)} direct=${p.directHit}`);

    if (demoManager?.isRecording && p.hitAge > 0.2) {

      demoManager.autoClipOnHit(p.hitAge, 0.2, undefined, undefined, undefined, {
        weapon: p.config.displayName, distance: p.hitDistance,
        // Same acc·dist·air·refire the HUD frag score uses — the tile ranks by it.
        score: shotScore(computeAccuracy(p.hitAccuracy, p.directHit), p.hitDistance, p.hitAge, p.config.weaponType),
      });

    }

  }

}





// Cluster pop: scatter bomblets in an upward cone - VISUAL only. Damage

// comes from the server's WeaponStats.cluster scatter on the carrier's

// validated blast; client-side pops never claim (untracked projectile).

export function spawnClusterBomblets(c: CombatCtx, p: Projectile): void {

  const {deps} = c;

  const { count, spread, fuse, sphere } = p.config.cluster!;

  const at = p.hitPointValid ? p.hitPoint : p.pos;

  // The scatter cone rides the carrier: axis = the carrier's heading

  // (up when it's parked), plus 80% momentum inheritance below - a

  // forward-flying shell rains its bomblets ALONG its arc instead of

  // popping a static fountain that ignores where it was going.

  // sphere mode (MRV) instead: full carrier velocity + a uniform random

  // direction, so the cloud keeps the arc's momentum and rains out.

  if (p.vel.lengthSq() > 1) {_coneAxis.copy(p.vel).normalize();}

  else {_coneAxis.set(0, 1, 0);}

  _coneQuat.setFromUnitVectors(_coneUp, _coneAxis);

  for (let i = 0; i < count; i += 1) {

    const yaw = simRand() * Math.PI * 2;

    if (sphere) {

      // Uniform sphere: cos(tilt) uniform in [-1,1], not tilt uniform.

      const u = simRand() * 2 - 1, s = Math.sqrt(1 - u * u);

      _bombDir.set(s * Math.cos(yaw), u, s * Math.sin(yaw));

    } else {

      const tilt = simRand() * spread; // 0..spread off the cone axis

      _bombDir.set(Math.sin(yaw) * Math.sin(tilt), Math.cos(tilt), Math.cos(yaw) * Math.sin(tilt))

        .applyQuaternion(_coneQuat);

    }

    // Per-instance config clone only carries the jittered fuse - and only

    // when the carrier SETS one: fuseless clusters (MRV) drop contact bombs

    // that pop on whatever they land on, not mid-air timers.

    const base = p.config.bomblet ?? BOMBLET_CONFIG;

    const cfg = fuse ? ((((((Object.assign({}, base, {maxLifetime: fuse * (0.6 + simRand() * 0.8)}))))))) : base;

    // Bomblet speed lives in the "playerVel" ctor arg: config.speed is 0 and

    // the ctor adds half the inherit term - so pass final velocity × 2.

    // Sphere: carrier velocity in FULL + uniform random kick; cone: 0.8×

    // carrier + cone scatter (unchanged).

    if (sphere) {

      _bombVel.copy(p.vel).addScaledVector(_bombDir, 6 + simRand() * 12)

        .multiplyScalar(2);

    } else {

      _bombVel.copy(_bombDir).multiplyScalar((9 + simRand() * 6) * 2)

        .addScaledVector(p.vel, 1.6);

    }

    const b = new Projectile(deps.lazyScene(), at, _bombDir, _bombVel, cfg);

    // Inherit the carrier's authorship: a remote shell's bomblets are
    // remote-authored too - unset reads as MINE downstream and every
    // pop stamps a dmg-echo the server can never confirm (the parity
    // spam). shotId deliberately does NOT ride: bomblets stay
    // untracked children that never claim.
    b.shooterId = p.shooterId;

    deps.world.projectiles.push(b);

  }

}





export function spawnImpactEffect(c: CombatCtx, p: Projectile): void {

  const {deps} = c;

  if (p.config.noExplosion) {

    // Bullet impact at the exact sweep intersection point (terrain hits

    // use the bisected hitPoint; ball/player hits use pos).

    const hitPos = p.hitPointValid ? p.hitPoint : p.pos;

    kineticHitFx(c.deps, p, hitPos);

    // Bullet hole on terrain hits only - enemy/player hits already get

    // damage numbers, bars, and spark feedback; a crumbled shell leaves

    // shards, not a decal.

    if (!p.hitBall && !p.hitPlayerId && !p.config.crumbles) {deps.lazyEffects().spawnBulletMark(hitPos);}

    return;

  }

  // Crumble weapons (bombard) present a shard burst, not a blast dome -
  // spawn it here and flag the blast presenter to skip the dome. Claim,
  // force and splash still ride the standard path below.
  if (p.config.crumbles) {spawnCrumbleShards(c.deps, p, p.hitPointValid ? p.hitPoint : p.pos);}

  // One AOE message for all weapons - the shared weapon table carries

  // weaponType, server resolves stats from it (no per-weapon message types)

  const networkManager = deps.lazyNetworkManager();

  const {weaponType} = p.config;

  // Canonical launchers bloom on a direct hit - the blast reach AND its

  // VFX dome grow together so the visual never lies about the damage area

  const bloom = p.directHit ? directHitAoeBonus(weaponType) : 1;

  // Untracked client-local children (cluster bomblets) skip the claim -

  // their damage is the server's WeaponStats.cluster scatter, so a claim

  // would just bounce off projectile resolution.

  // Unarmed sticky failsafe pops (never attached - fuseAge -1) claim no

  // blast: the shell was inert, so this explosion is cosmetic only.

  const blastPos = p.hitPointValid ? p.hitPoint : p.pos;

  // burstShards: shell bursts spherically ON TOP of the dome the blast
  // presenter draws - the ball's mass visibly goes somewhere. Spherical
  // (no impulseDir/inheritVel): reads the same from any hit angle.
  if (p.config.burstShards) {
    deps.world.debrisList.push(new BallDebris(
      deps.lazyScene(), deps.lazyTerrain(), blastPos,
      _crumbCol.setHex(p.config.meshColor), p.config.bodyRadius,
      { bodyRadius: p.config.bodyRadius, kind: 'rock' },
    ));
  }

  const airtime = p.hitAge > 0 ? p.hitAge : p.age;

  const claimable = !(p.config.sticks && p.fuseAge() < 0)

    && p.config.needsServerTracking !== false

    && (p.serverProjectileId !== null || p.shotId !== null);

  // Claim dead on arrival = the server WILL reject - suppressing the

  // claim alone isn't enough: the blast's predicted damage on remote

  // players (numbers, bars, knockback) would be ghost feedback for a

  // blast the authority never applies.

  const claimLegal = claimable ? aoeVerdict(c, p, blastPos, airtime).ok : undefined;

  if (claimable && claimLegal === false) {

    // Client verdict says the server will reject - but pre-judging and
    // staying silent is how "hit him, no damage" happens: the blast FX
    // played while the authority never heard of it. Send the claim
    // anyway - the server's own judge is the only verdict that counts,
    // and a real reject echoes back for prediction cleanup. Predicted
    // damage still stays off (applyExplosionForce gate below), so a
    // rejection leaves no ghost numbers.
    deps.logger.info(`[Shot] aoe claim pre-flight fail - sending anyway, server decides: ${p.config.displayName} air=${airtime.toFixed(2)}s`);

  }

  // Server-simmed weapons predict the blast (FX/knockback/numbers stay

  // local) but never send the claim - the authority's shell arrives at

  // the same contact and declares it via broadcasts.

  const sendAOE = !claimable || (serverSimmed(weaponType) && networkManager.authorityShells())

    ? (): void => { return; }

    : (pos: { x: number; y: number; z: number }, targetId: string | null): void =>

    networkManager.sendAOEShot({

      position: pos, weaponType, excludeTargetId: targetId,

      // hitAge is 0 when the projectile detonated without a swept hit

      // (terrain, fuse) - 0 isn't nullish, so `??` never fell back and

      // claims went out with airtime=0 → reach check rejected them all.

      projectileId: p.serverProjectileId ?? null, airtime,

      directHit: p.directHit || undefined, shotId: p.shotId ?? undefined,

    });

  processProjectileExplosion(c, {

    pos: blastPos,

    crumbles: p.config.crumbles,

    claimLegal,

    radius: p.config.aoeRadius * bloom * deps.lazyPlayer().mods.aoeRadius,   // gameplay radius = server truth (incl. perk)

    force: p.force,

    forceMode: p.forceMode,

    // Splash amount = the direct hit's damage (banded by ring in shared

    // aoeDamage) - the stat-block aoeDamage only backs zero-direct specials.

    // igun: splash pays table aoeDamage ×5 (same law as server
    // combatBlast) - ordnance pops stay lethal, rapid pops stay chip.
    aoeDamage: deps.world.igun === true
      ? (getWeaponStats(weaponType).aoeDamage || p.config.aoeDamage) * IGUN_AOE_MULT
      : getWeaponStats(weaponType).directDamage || p.config.aoeDamage,

    forceMultiplier: p.config.forceMultiplier,

    directHit: p.directHit,

    directHitTargetId: p.hitPlayerId,

    age: p.age,

    sendAOE,

    explosionTint: p.config.damageColor,

    vfxRadius: p.explosionRadius * bloom, // VFX dome grows with the damage area

    weaponType,

    shooterId: p.shooterId ?? undefined, // authorship - without it a bot's blast reads as MINE (marker/numbers/self-splash scale)

    air: p.hitAge > 0 ? p.hitAge : p.age, // same fallback the AOE claim uses

    shotId: p.shotId,

  });

}





// Visual effect only - no AOE, no damage, no server traffic

export function spawnVisualOnly(c: CombatCtx, p: Projectile): void {

  const {deps} = c;

  // Prefer the swept hitPoint - on a bounce-fail the integrated pos is

  // already inside the terrain and the blast would render underground

  const pos = p.hitPointValid ? p.hitPoint : p.pos;

  if (p.config.noExplosion) {

    kineticHitFx(c.deps, p, pos);

    if (!p.hitBall && !p.hitPlayerId && !p.config.crumbles) {deps.lazyEffects().spawnBulletMark(pos);}

    return;

  }

  if (p.config.crumbles) {

    // Crumble weapons present shards, not a dome - on remote replicas too.
    spawnCrumbleShards(c.deps, p, pos);

    return;

  }

  // Disc/bolt wake (proxy) hits get a toned-down compact pop; direct hits keep the full blast.
  const wakeOnly = !p.directHit && Boolean(p.hitBall || p.hitPlayerId);
  const toned = wakeOnly && (p.config === DISC_CONFIG || p.config === BOLT_CONFIG);
  const sizeScale = p.explosionRadius / EXPLOSION_VFX_RADIUS * (toned ? 0.55 : 1);
  deps.world.explosions.push(new Explosion(deps.lazyScene(), pos, p.directHit, p.age, deps.lazyTerrain(), sizeScale, p.config.damageColor, toned ? 'bolt' : p.config.vfx));

  // burstShards: the ball comes APART in the blast - a spherical shard
  // burst on top of the dome so the shell's mass visibly goes somewhere.
  // No impulseDir/inheritVel: the detonation owns the spray, not the
  // flight line - a side-on hit reads the same as a nose-on one.
  if (p.config.burstShards) {
    deps.world.debrisList.push(new BallDebris(
      deps.lazyScene(), deps.lazyTerrain(), pos,
      _crumbCol.setHex(p.config.meshColor), p.config.bodyRadius,
      { bodyRadius: p.config.bodyRadius, kind: 'rock' },
    ));
  }

  sfx.explosionAt(pos, p.directHit);

}





// Projectile exploded: spawn effect, apply AOE, score hits, notify server/demo

/** Rope-dart connect - the Hook's whole payload. The dart's ribbon trail
 *  IS the rope; nothing extra paints. The IMPULSE is authority-split:
 *  terrain/ball anchors reel the owner toward the contact (local predict
 *  + wire echo deduped by the stamp), a body connect yanks the victim
 *  toward the shooter (local dead-reckon on remotes - the server wire is
 *  law), and a hook landing on ME pulls me toward the attacker. A whiff -
 *  no body, no contact point - is a snapped line: nothing happens. */
function hookConnect(c: CombatCtx, p: Projectile): void {
  const {deps} = c;
  if (!p.hitPlayerId && !p.hitPointValid) {return;}
  const stats = getWeaponStats(WeaponType.Hook);
  const anchor = p.hitPointValid ? p.hitPoint : p.pos;
  const player = deps.lazyPlayer();
  const mine = !p.shooterId;
  if (p.isRemote) {return;} // wire knockback carries the reel for non-mine shells
  if (p.hitPlayerId && p.hitPlayerId !== 'local') {
    // My dart connected with a remote body - the wire carries the real
    // reel; a wrong predicted launch reads as sling-then-warp.
    return;
  }
  if (p.hitPlayerId === 'local') {
    // A bot's dart caught me offline - I get reeled toward the thrower.
    const atk = deps.world.remotePlayers.get(p.shooterId ?? '');
    player.applyPull(atk?.position ?? anchor, stats.knockbackForce * player.mods.knockbackTaken, true);
    return;
  }
  if (mine) {
    // Terrain/structure/creature anchor - reel myself toward the contact.
    // Stamp the prediction so the server's knockback echo dedupes instead
    // of double-yanking (same contract predictLocalShove keeps).
    const mag = stats.knockbackForce * player.mods.knockbackTaken;
    player.applyPull(anchor, mag, true);
    // Offline has no echo lane - same `self` contract predictLocalShove
    // keeps, or expiry reports a phantom kb-echo that could never exist.
    deps.world.selfBlastStamps.push({ x: anchor.x, y: anchor.y, z: anchor.z, t: performance.now(), by: 'local', f: mag,
      self: !(deps.lazyNetworkManager()?.isConnected?.() ?? false) });
  }
}

export function handleProjectileImpact(c: CombatCtx, p: Projectile): void {

  const {deps} = c;

  // Remote shells are server-authoritative: render the effect locally,

  // but never report AOE/destroy/hits - that's the shooter's client's job.

  // (GL shells explode on their 2.5s fuse on every observing client.)

  if (p.isRemote) {

    spawnVisualOnly(c, p);
    // Hook replicas: observers see the rope snap; impulses arrive on the wire.
    if (p.config.hook) {hookConnect(c, p);}

    // Bomblets are visual-only anyway - remote viewers still need the

    // rain, or an airburst reads as a midair pop with no payload.

    if (p.config.cluster) {spawnClusterBomblets(c, p);}

    // The replica is visual-only for DAMAGE (server declares it), but the

    // blast still physically shoves the local player - predict the shove

    // here so its knockback echo dedupes on the stamp instead of landing

    // raw and late. Without this every enemy blast felt like a grab.

    if (!p.config.noExplosion && p.config.aoeRadius > 0) {

      // The wire's detonation point beats the painted contact when the
      // destroy already landed - a self-popped replica drifts meters off
      // the server's true blast, and the stamp/echo center has to live
      // where the authority judged it or the shove registers against a
      // phantom center (the kb-echo miss class).
      const wireAt = p.serverProjectileId ? projWireAt.get(p.serverProjectileId)?.at : undefined;
      const blastPos = wireAt ? (_kbWirePos ??= new THREE.Vector3()).set(wireAt.x, wireAt.y, wireAt.z) : (p.hitPointValid ? p.hitPoint : p.pos);

      const bloom = p.directHit ? directHitAoeBonus(p.config.weaponType) : 1;

      // Remote hook whiffs yank nobody - the generic pull is for real
      // blasts; the rope's reel only exists on a wire grapple.
      if (!p.config.hook) {c.predictLocalShove(blastPos, p.config.aoeRadius * bloom, p.force, p.forceMode, p.shooterId ?? undefined, { pid: p.serverProjectileId ?? undefined, wt: p.config.weaponType, pop: p.popClass });}

      // Replayed prey sims (balls/nuggets) get the same predicted shove --

      // the authority knocks them on the blast tick, so without this they

      // flew ballistic until the next segment re-anchored them (~0.5s of

      // visible rubberband per remote blast near a swarm).

      c.applyForceToPrey(blastPos, p.config.aoeRadius * bloom, p.force, p.forceMode);

    }

    return;

  }



  // Premature-detonation split (Reitich's bPredictFX): a contact on a
  // remote BODY is the only mispredictable pop - the victim moved in the
  // transit gap and the wire blast lands where the server actually saw
  // it (offM 55-90m in dumps). Painting our ghost blast would lie twice;
  // the wire 'gone' still owns the true detonation. The CLAIM still
  // fires below - the server adjudicates the hit from real aim data.
  // Terrain hits are provably identical both sides - predict them fully.
  const ghostBodyPop = p.hitPlayerId !== null && p.hitPlayerId !== 'local' &&
    (p.serverProjectileId !== null || (p.shotId !== null && deps.lazyNetworkManager()?.isConnected() === true));
  if (ghostBodyPop) {p.ghostBodyPop = true;}
  else {spawnImpactEffect(c, p);} // flag it - the wire 'gone' owes us the real blast

  recordProjectileHit(c, p);

  if (p.config.cluster) {spawnClusterBomblets(c, p);}



  if (p.hitBall && !p.config.hook) {handleBallHit(c, p, p.hitBall);}

  if (p.config.hook) {hookConnect(c, p);}

  else if (p.hitPlayerId) {handlePlayerHit(c, p, p.hitPlayerId);}



  // Destroy LAST - this tombstones the server-tracked id. WS is ordered,

  // so sending it ahead of the aoeShot/shot claims above used to make

  // every blast arrive at a projectile the server no longer knew

  // ("blast with no known projectile" - splash silently never applied).

  // Server-simmed shells never claim: the authority's own sim owns the

  // lifecycle and its projectileDestroyed echo does the tombstoning.

  if ((p.serverProjectileId || p.shotId) && !(serverSimmed(p.config.weaponType) && deps.lazyNetworkManager().authorityShells())) {

    deps.lazyNetworkManager().sendProjectileDestroy(p.serverProjectileId ?? '', p.shotId ?? undefined);

  }

}



const _crumbCol = new THREE.Color();

/** Subset of CombatDeps the kinetic-pop path touches - also satisfied by
 *  NetDeps so the wire 'gone' repaint can share it. */
type ImpactFxDeps = Pick<CombatDeps, 'lazyEffects' | 'lazyScene' | 'lazyTerrain' | 'world'>;



/** Kinetic-hit feedback for noExplosion shells - the bullet puff is the

 *  floor; an embedding spear (javelin) earns a compact kinetic burst and

 *  its own thunk voice so a 60dmg dart doesn't feel like a pistol hit. */

/** Crumble weapons (bombard): the ball IS the ordnance - it bursts into
 *  rock shards at the contact point, riding the same pooled debris a
 *  creature death would. No dome, just the mass coming apart. Shared by
 *  the local impact path (which also runs the standard splash) and by
 *  remote replicas. */
function spawnCrumbleShards(deps: ImpactFxDeps, p: Projectile, pos: THREE.Vector3): void {

  deps.lazyEffects().spawnImpact(pos, p.vel);

  _debrisDir.copy(p.vel).normalize();

  deps.world.debrisList.push(new BallDebris(

    deps.lazyScene(), deps.lazyTerrain(), pos,

    _crumbCol.setHex(p.config.meshColor), p.config.bodyRadius,

    { bodyRadius: p.config.bodyRadius, impulseDir: _debrisDir, inheritVel: p.vel, kind: 'rock' },

  ));

  // ?debug: show the (small) splash reach like every blast - a crumble
  // draws no dome, so this is the only read on the damage envelope.
  if (urlParams.debug && p.config.aoeRadius > 0) {

    deps.world.aoeGizmos.push(new AoeGizmo(deps.lazyScene(), pos, p.config.aoeRadius));

  }

  sfx.explosionAt(pos, false, p.config.weaponType, p.vel);

}

export function kineticHitFx(deps: ImpactFxDeps, p: Projectile, pos: THREE.Vector3): void {

  if (p.config.crumbles) {spawnCrumbleShards(deps, p, pos); return;}

  deps.lazyEffects().spawnImpact(pos, p.vel);

  // noExplosion shells can still declare a VFX pop - energy bolts get the
  // compact 'bolt' snap instead of nothing, embedding spears keep 'punch'.
  const vfx = p.config.vfx ?? (p.config.embeds === undefined ? undefined : 'punch');

  if (vfx === undefined) {return;}

  deps.world.explosions.push(new Explosion(

    deps.lazyScene(), pos, p.directHit, p.age, deps.lazyTerrain(),

    3.4 / EXPLOSION_VFX_RADIUS, p.config.damageColor, vfx,

  ));

  sfx.explosionAt(pos, false, p.config.weaponType, p.vel);

}



// Score breakdown is an AIRSHOT reward - grounded hits get the plain

// hit marker, not a stat sheet. `airborne` = target's feet >0.6m over

// terrain at the moment of the hit (same threshold the anim code uses).

export function logHitScore(c: CombatCtx, p: Projectile, target: 'ball' | 'player', airborne: boolean, targetId?: string): void {

  const {deps} = c;

  const acc = computeAccuracy(p.hitAccuracy, p.directHit);

  const dist = p.hitDistance;

  const air = p.hitAge;

  const score = shotScore(acc, dist, air, p.config.weaponType);

  deps.lazyPlayer().score += score;

  deps.logger.info(`[Hit] ${target}${targetId ? ` ${targetId}` : ''} direct=${p.directHit} air=${airborne} accRaw=${p.hitAccuracy.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);

  if (airborne) {deps.fragMessages.showScore(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`, air);}

  deps.lazyHud().showHitMarker();

  sfx.hitMarker(p.directHit);

}



// Shared death pipeline for direct hits AND splash kills - debris,

// nuggets, kill credit, elite split. Without this a blast kill would

// silently delete the entity with no payout.

export function onTargetDestroyed(c: CombatCtx, ball: Targetable, impulse?: THREE.Vector3, weaponType?: number, shooterId?: string): void {

  const {deps} = c;

  // Railgun reward: any kill (direct or its splash) instantly reloads -

  // the "not useless" payoff that turns a slow precision weapon into a

  // chain-kill tool against clusters. Only when the kill is MINE -

  // a bot's railgun shouldn't refund my trigger.

  const mine = !shooterId || shooterId === 'local';

  if (mine && weaponType === WeaponType.Railgun) {deps.lazyPlayer().refundWeaponCooldown();}

  if (impulse) {_debrisDir.copy(impulse).normalize();} else {_debrisDir.set(0, 0.5, 0);}

  ichorDeath(c, ball, _debrisDir);

  corpseBurst(c, ball, _debrisDir);

  screenShake.blast(ball.pos, 1.6, deps.lazyPlayer().pos);

  sfx.enemyCue(ball.pos, ball.dieCue ?? 'die');

  // kills++ is personal credit - bot-authored kills still reach the

  // referee via onCreatureKilled(shooterId), just not my counter.

  if (!ball.scoreless) {

    if (mine) {deps.lazyPlayer().kills += 1;}

    deps.onCreatureKilled?.(shooterId);

  }

  // Connected, the server's RoomPickups drop is the backed loot - a

  // local nugget here collects into a heal claim the server never

  // minted credit for (nocredit reject → predicted health desyncs).

  // authoritySims - not isConnected: a P2P host has no RoomPickups, so

  // the loot economy falls back to local nuggets there too.

  if (!ball.lootless && !deps.lazyNetworkManager().authoritySims()) {

    // Headhunt hunts tokens - creature drops feed the hold economy the
    // same way gems feed the bank economy in nuggets (server parity).
    const token = deps.world.mode === 'headhunt';
    const tier = token ? tokenTier(1) : null;

    for (let n = 0; n < Math.round(ball.scale); n += 1) {

      const ng = new Nugget(deps.lazyScene(), ball.pos, ball.vel.clone().multiplyScalar(0.5),
        tier?.color ?? PICKUP_ACCENT.gem, token ? pickupParts('token') : null, tier?.scale ?? 1);
      if (token) {ng.kind = 'token';}

      deps.nuggets.push(ng);

    }

  }

  ball.onDeath?.(ball); // elite split - entities.ts spawns the children

  // Record here, not in handleBallHit - splash kills need it too

  if (deps.lazyDemoManager()?.isRecording) {

    // Wire id for net balls - Spawned/Bounce key on it; recording the client

    // namespace id here leaves the kill invisible to replay.

    deps.lazyDemoManager()!.recordTargetDestroyed(targetDemoId(ball), { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, ball.variant, ball.health);

  }

}



// Per-target chaingun ramp state: targetId → last hit time + chain count.

// Entries prune lazily on write - the map stays small.





/** A non-beam direct hit invests its damage into the victim's banked pop

 *  charge - the rest of the charge stays smoldering, not wasted. */

export function detonateCharge(p: Projectile, ball: Targetable, dmg: number): void {

  if (p.config.weaponType !== WeaponType.Lightning) {lgDischarge(ball.id, dmg, ball.pos);}

}



/** Wind the chaingun's bank on a hit: at the cap the shot dumps a

 *  stagger shove into the victim and the bank resets for another

 *  wind-up - sustained tracking pays in displacement, not damage. */

export function chaingunBank(c: CombatCtx, p: Projectile, ball: Targetable): void {

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

    for (const [id, s] of c.chainRamp) {if (now - s.t > CHAIN_WINDOW) {c.chainRamp.delete(id);}}

  }

}



/** Nugget Wars bots damaging creatures: the identical funnel a

 *  projectile hit runs - aggro report, damage numbers, kill pipeline.

 *  attackerId set ⇒ not mine: apply damage but skip the floating number

 *  (personal feedback is for damage I dealt). */

export function hitTargetLocal(c: CombatCtx, t: Targetable, dmg: number, attackerId?: string): boolean {

  const {deps} = c;

  deps.reportTargetDamage?.(t, dmg);

  if (!attackerId || attackerId === 'local') {

    deps.lazyDamageNumbers().spawn(t.pos, Math.round(dmg), '#ffe08a', deps.lazyCamera());

  }

  // Server-owned damage (bot swings, deployable attacks): the authority

  // settles the same hit - claiming would double-dip.

  if (t.takeDamage(dmg, { serverPaid: true })) { onTargetDestroyed(c, t, t.vel, undefined, attackerId); return true; }

  if (!t.hideHealthBar) {deps.lazyHealthBarSystem().spawnBall(t, dmg, t.health);}

  return false;

}

