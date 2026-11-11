// Blast force application: push/pull on the local player, creatures,
// nuggets, and remote players - plus splash damage numbers/health bars.
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
import { parityMiss, parityStamp, expectDamageEcho, kbEchoHorizon, kbStampDeadline, projWireAt } from './parity.js';
import { ballGhostPos } from '../projectiles/sweep.js';
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
// swallows the prediction - keeps the client from flashing knockback/
// damage the funnel will never confirm (then resyncing it back).
const solids = () => Projectile.solidColliders;

const occluded = (pos: THREE.Vector3, target: THREE.Vector3): boolean =>
  solids().length > 0 && blastOccluded(pos, target, solids());

// Rewound-eval scratch - lazily cloned off the player so THREE stays a
// type-only import here (per-blast, not per-frame - allocation is fine).
let _rewound: THREE.Vector3 | null = null;
let _ghost: THREE.Vector3 | null = null;

// Splash damage-number color follows the weapon - getProjectileConfig
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
  /** Shell's flight time at detonation - offline kill-feed `[1.3s]` tag. */
  air?: number;
  /** The detonating shell's nonce - stamps splash predictions so a server
   *  whiff reads as a ghost the same way a direct hit does. */
  shotId?: string | null;
}

export function createBlastForce(deps: CombatDeps, hooks: BlastForceHooks) {

  // Nuggets are light pickups - blast throws them at a boosted force so
  // explosions visibly scatter loot instead of it hovering through the blast
  function applyForceToNuggets(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull'
  ): void {
    // Predict what the server applies (RoomPickups.knock): the shared
    // aoeImpulse falloff × 0.4 - NOT a.forceMultiplier: the server's
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
    applyTo: (t: Forceable, f: number) => void,
    los = true,
  ): void {
    const { pos, radius, aoeDamage, weaponType } = a;
    const scales = weaponType === undefined ? undefined : getWeaponStats(weaponType).aoeScales;
    for (const ball of deps.targets) {
      if (ball.dead) {continue;}
      // Net-driven creatures sit at the server's rewound epoch too -
      // creatureSweep rewinds transit+renderLag (ballGhostPos is filled
      // per tick in the combat pass). Live pos is the replay, not the
      // judgment.
      const bpos = ballGhostPos.get(ball) ?? ball.pos;
      const db = bpos.distanceTo(pos);
      const br = ball.hitRadius ?? ball.radius;
      // One envelope for every blast effect - the creature's own body
      // radius still counts (a surface graze is contact, like players).
      const threshold = radius + br;
      // The server's prey knock ignores occlusion - a flat distance
      // envelope - so los:false mirrors authority for knock prediction.
      // Boundary matches the server's `d > envelope` skip: a graze at
      // exactly radius+body still eats the shove there.
      if (db > threshold || (los && occluded(pos, bpos))) {continue;}
      applyTo(ball, a.force * a.forceMultiplier);
      // Splash actually hurts enemies - falloff-scaled like players, with
      // the same damage number + health bar feedback as direct hits
      // (without it, splash damage was invisible and read as "no damage").
      const dmg = aoeDamageOf(aoeDamage, db, radius, scales);
      if (dmg < 1) {continue;}
      // Numbers are MY-hit feedback - a bot blast salting a creature
      // shouldn't stamp them under my crosshair (same gate as remotes).
      if (!a.shooterId) {deps.lazyDamageNumbers().spawn(ball.pos, dmg, splashColor(weaponType), deps.lazyCamera());}
      deps.reportTargetDamage?.(ball, dmg);
      // Every connected blast is server-paid: weapon shells detonate in
      // the authority's sim and deployable pops (mines) detonate in
      // tickMine + preySplash - a claim on top would double-pay.
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
  // ~1 RTT before the victim's real trajectory streams back - RemotePlayer
  // runs it as dead reckoning and clears stale pre-hit snapshots so there's
  // no snap-back when interpolation resumes.
  function applyForceToRemotes(a: BlastArgs): void {
    const { pos, radius, force, forceMode, aoeDamage, directHitTargetId, shooterId, weaponType } = a;
    const scales = weaponType === undefined ? undefined : getWeaponStats(weaponType).aoeScales;
    for (const [playerId, rp] of deps.world.remotePlayers) {
      if (rp.isDead) {continue;}
      // Envelope math at the GHOST epoch - the server judges the victim
      // at wirePosition rewound ~0.7·renderDelay (ghostBack), not at the
      // rendered body (~150ms interp-stale). Evaluating the envelope at
      // rendered pos was the orphan/dmg-echo driver: predicted inside on
      // the stale visual while the wire truth was outside, or vice versa.
      _ghost ??= rp.position.clone();
      // The authority's rewind is shallower by the victim's own transit:
      // epoch = view + (victimPing − shooterPing)/2 - pass the shooter's
      // transit so a fat-pipe victim is judged where the server sees them.
      const nmPing = deps.lazyNetworkManager()?.serverPingMs ?? deps.lazyNetworkManager()?.getPing?.() ?? 0;
      const shooterTransit = shooterId === undefined || shooterId === 'local'
        ? nmPing / 2
        : (deps.world.remotePlayers.get(shooterId)?.wirePingMs ?? nmPing) / 2;
      const vpos = rp.ghostPosition?.(_ghost, shooterTransit) ?? rp.position;
      // Match server damage exactly: 1 - dist/radius inside radius, 0 outside -
      // knockback uses the same envelope (aoeImpulseT1), so nothing predicts
      // damage or shove the server never applies.
      const dist = vpos.distanceTo(pos);
      const impulse = Math.min(aoeImpulseT1At(force, pos, vpos, radius, rp.armorClass) * KNOCKBACK_SCALE, BLAST_IMPULSE_MAX);
      if (impulse <= 0) {continue;}
      if (occluded(pos, vpos)) {continue;}
      // Remote knockback prediction disabled: a wrong guess slung the
      // body to a position the wire never produced (sling-then-warp).
      // Wire position updates carry the real shove ~1 tick out; damage
      // prediction below is unaffected. Re-enable via
      // rp.applyPredictedKnockback(pos, impulse, forceMode === 'pull', vpos)
      // once predicted-vs-wire parity is validated live.
      if (playerId === directHitTargetId) {continue;}
      // Hitmarker is personal feedback - a bot's blast (shooterId set)
      // clipping a remote isn't my frag to celebrate.
      if (!a.shooterId) {deps.lazyHud().showHitMarker();}
      const aoeDmg = aoeDamageOf(aoeDamage, dist, radius, scales);
      // Friendly splash deals nothing in team rooms (the server's rule) -
      // the number/predicted dip must not lie ahead of it, so this check
      // precedes ALL feedback, not just the echo stamp it used to gate.
      const victimTeam = deps.lazyNetworkManager()?.getPlayers?.().get(playerId)?.team;
      const friendly = victimTeam !== undefined && victimTeam === deps.world.localTeam;
      // Splash on a player/bot shows a number too - direct hits had one
      // (impact.ts) but blast feedback stopped at the hitmarker, so the
      // common "rocket at their feet" read as dealing nothing.
      if (!a.shooterId && !friendly && aoeDmg >= 1) {
        deps.lazyDamageNumbers().spawn(rp.position, aoeDmg, splashColor(weaponType), deps.lazyCamera());
      }
      if (deps.botHit?.(playerId, aoeDmg, pos, shooterId, a.weaponType, a.air)) {continue;} // local authority resolved it
      if (!friendly) {deps.lazyHealthBarSystem().predictDamage(playerId, aoeDmg);}
      // My blast predicted splash the server may whiff - stamp it like the
      // direct-hit path does or a silent splash miss reads as clean damage.
      // The server skips friendly damage in team rooms, so a stamped
      // teammate would be a false ghost - only stamp plausible victims.
      if (!a.shooterId && !friendly && aoeDmg >= 1 && deps.lazyNetworkManager()?.authoritySims?.()) {
        expectDamageEcho(playerId, aoeDmg, weaponType, a.shotId, { x: pos.x, y: pos.y, z: pos.z },
          { x: vpos.x, y: vpos.y, z: vpos.z });
      }
    }
  }

  /** Predicted shove for the LOCAL body - shared by authored blasts
   *  (applyExplosionForce) and remote-blast replicas (impact.ts). Returns
   *  true when the player sat inside the envelope - whether this call
   *  applied the impulse or a raced wire echo already spent it. */
  function predictLocalShove(pos: THREE.Vector3, radius: number, force: number, forceMode: 'push' | 'pull', shooterId?: string, meta?: { pid?: string; wt?: number; pop?: string }): boolean {
    const player = deps.lazyPlayer();
    // Ledger the blast itself, not just the shove: when the wire
    // knockback arrives, net/players.ts can tell 'the blast rendered but
    // its envelope math said I was out' from a shove that truly came
    // from nowhere - only the second deserves the anomaly log.
    deps.explosionTracker.addExplosion(pos, force, shooterId ?? 'remote');
    // Dead body: the server judges at the respawn position, not where the
    // corpse lies - a predicted shove here can only be a phantom miss.
    if (player.isDead) {return false;}
    // The server judges this blast at its movement SHADOW - our position
    // ~uplink-transit ago - not at the live render pos. Evaluating the
    // envelope at the rewound pos is what the authority will see, so rim
    // hits stop flipping on the live-vs-shadow gap (the kb-echo class).
    // serverPingMs (reliable lane) is the truer uplink proxy than the
    // datagram ping; +75ms covers the input-processing interval + tick
    // quantization the shadow sits behind even at LAN ping.
    const nmPing = deps.lazyNetworkManager?.()?.serverPingMs ?? deps.lazyNetworkManager?.()?.getPing?.() ?? 0;
    // The server's rewind depth isn't a fixed transit - splashOne judges
    // the victim at shooterTransit + the shooter's render lag − victim
    // uplink, i.e. roughly the shooter's viewLagMs of me. A skier at
    // 40m/s sits ~4m differently between the shallow fixed 75ms rewind
    // and the real ghost epoch - that gap IS the measured kb-echo miss
    // (offM:0 - same blast center, wrong victim point). Fall back to the
    // transit estimate when the shooter isn't a tracked remote.
    // Server rewind = shooterTransit + shooterViewLag − myTransit - the
    // shooter's viewLag alone undershoots the ghost by (shooterPing −
    // myPing)/2 - a fat-pipe shooter's server judges me ~90ms deeper
    // than their rendered epoch, the f:30 pop:wire refuse class.
    const shooterRp = shooterId ? deps.world.remotePlayers.get(shooterId) : undefined;
    const shooterLagMs = shooterRp?.rewindLocalMs(nmPing) ?? 0;
    const lagSec = Math.min(0.35, Math.max(0, shooterLagMs > 0 ? shooterLagMs / 1000 : nmPing / 2000 + 0.075));
    const evalPos = lagSec > 0 && player.vel ? (_rewound ??= player.pos.clone()).copy(player.pos).addScaledVector(player.vel, -lagSec) : player.pos;
    const dpx = evalPos.distanceTo(pos);
    // Knockback reach = damage reach: the blast ends at aoeRadius, same
    // bound the server applies and the ?debug gizmo draws.
    // Spawn shield: the server refuses enemy-blast shove/damage during
    // the window - predicting it anyway flies the protected player until
    // the silent resync snaps them back (the "pushed by wind" report).
    // Self blasts still predict (the server applies those); a friendly's
    // blast suppression is harmless - its wire knockback lands anyway.
    const shielded = shooterId !== undefined && shooterId !== 'local' && performance.now() < player.protectedUntil;
    const margin = radius - (dpx - t1Minbox(player.appliedClass));
    // Rim abstain: within ~1.5m of the envelope edge the evalPos-vs-
    // shadow quantization (~±30-50ms·vel) genuinely can't call it -
    // predicting here is the kb-echo class (false shove, silent snap) or
    // the kb-unpredicted class (missed real shove). Abstain and let the
    // wire's verdict land ~one transit later - honest, never wrong.
    if (shielded || margin < 0 || margin < 1.5 || occluded(pos, evalPos)) {return false;}
    const now = performance.now();
    const impulse = Math.min(
      aoeImpulseT1At(force, pos, evalPos, radius, player.appliedClass) * KNOCKBACK_SCALE * player.mods.knockbackTaken,
      BLAST_IMPULSE_MAX);
    // Dedup, reverse direction: the knockback echo can beat its blast's
    // replica explode (handlers run on arrival, the predicted shove waits
    // for the next projectile tick). A recorded raw echo at this center
    // means the shove already landed - consume it, don't re-apply.
    const rkb = deps.world.recentKb;
    // Same 700ms horizon as the stamp lifecycle - under drain-burst lag
    // the replica's explode can trail the echo's wire arrival past 400ms,
    // and a stale window double-shoves + strands a false kb-echo stamp.
    // Same 18m + force match as the stamp consume in players.ts - replica
    // blast centers diverge from the server's detonation by trajDiv's p95
    // (~25m tail), so 8m missed real echoes and re-applied their shoves.
    // recentKb carries the wire's APPLIED impulse - compare against the
    // same falloff-scaled impulse we would apply, not the raw blast force.
    // Horizon extends while the wire starves - a stalled echo isn't a
    // refusal (a 1.4s inbound gap delays every echo past a flat 700ms).
    const kbNm = deps.lazyNetworkManager?.();
    const horizon = kbEchoHorizon(kbNm?.serverPingMs ?? kbNm?.getPing?.() ?? 0, kbNm?.msSinceLiveRx?.() ?? 0);
    const dupCands: number[] = [];
    for (let k = 0; k < rkb.length; k += 1) {
      const s = rkb[k]!;
      if (now - s.t < horizon && Math.hypot(s.x - pos.x, s.y - pos.y, s.z - pos.z) < 18) {dupCands.push(k);}
    }
    // Same identity rule as the stamp consume: center+time wins; the
    // wire's applied impulse vs our predicted falloff only disambiguates
    // multiple same-spot echoes - a hard veto double-shoves.
    const dup = dupCands.length === 0 ? -1
      : dupCands.reduce((a, b): number => Math.abs((rkb[a]!.f ?? impulse) - impulse) <= Math.abs((rkb[b]!.f ?? impulse) - impulse) ? a : b);
    if (dup !== -1) {rkb.splice(dup, 1); return true;}
    // Record the applied delta - a refused verdict (stamp expiry with no
    // echo) reverses exactly this, so a phantom shove can't displace the
    // body and poison every later envelope eval.
    const pv0 = player.vel ?? { x: 0, y: 0, z: 0 };
    const vx = pv0.x, vy = pv0.y, vz = pv0.z;
    if (forceMode === 'push') {player.applyKnockback(pos, impulse);}
    else {player.applyPull(pos, impulse);}
    const pv1 = player.vel ?? pv0;
    const iv = { x: pv1.x - vx, y: pv1.y - vy, z: pv1.z - vz };
    // Stamp the prediction - the server echoes this same shove back as a
    // `knockback` message ~RTT later; net/players.ts consumes the stamp
    // so the blast can't land twice. The wire force is the APPLIED
    // impulse (falloff + perk + cap), not the raw blast force - stamping
    // the raw value mismatched every non-point-blank echo, which both
    // stranded the stamp (kb-echo) and let the echo double-shove.
    const stamps = deps.world.selfBlastStamps;
    // self: my own blast - the server deliberately skips shove() for
    // humans on their own blast (combatBlast splashTargets: shoveOnly
    // skips the wire echo - "humans self-predict their displacement").
    // No echo will ever arrive: confirmation-free by protocol design,
    // so expiry is silent. Remote blasts (by=shooterId) still audit.
    // Offline has no echo lane either - a bot-shooter blast stamped as
    // 'remote' can never be confirmed, so treat it self/silent or the
    // expiry reports a phantom kb-echo.
    const echoless = shooterId === undefined || shooterId === 'local' || !(kbNm?.isConnected?.() ?? false);
    const stamp: (typeof stamps)[number] = { x: pos.x, y: pos.y, z: pos.z, t: now, by: shooterId, self: echoless, f: Math.round(impulse * 10) / 10, m: Number(margin.toFixed(1)), iv: { x: iv.x, y: iv.y, z: iv.z }, pid: meta?.pid, wt: meta?.wt, pop: meta?.pop };
    // Wire fate may already be in hand - a wire-destroyed replica pops
    // inside the destroy handler, AFTER the attach sweep ran, so the
    // stamp must look the point up itself or it sits unpaired till expiry.
    const fate = stamp.pid ? projWireAt.get(stamp.pid) : undefined;
    if (fate) {stamp.wireAt = fate.at; stamp.wireT = fate.t;}
    stamps.push(stamp);
    // Offline has no echo lane — stamping 'kb-echo' just reports the
    // self-shove as a parity miss at expiry; same reason `self` is set.
    if (kbNm?.isConnected?.() ?? false) {parityStamp('kb-echo');}
    // Settle older stamps: a predicted self-shove the server never echoed
    // back (~700ms past the consume window) was rejected server-side -
    // loud parity miss, not a silent expiry.
    for (let i = stamps.length - 1; i >= 0; i -= 1) {
      if (now > kbStampDeadline(stamps[i]!, horizon)) {
        if (!stamps[i]!.self) {
          const s = stamps[i]!;
          // Refused verdict - undo the predicted impulse before the next
          // eval reads the drifted body.
          if (s.iv && player.vel) {player.vel.x -= s.iv.x; player.vel.y -= s.iv.y; player.vel.z -= s.iv.z;}
          // wireAt known → the server's blast point is the verdict's
          // center - an unechoed stamp there is a real adjudication miss.
          // pid without wireAt → the replica popped where the server
          // shell never detonated (painted traj/body divergence) - the
          // echo can't exist, that's replica lifecycle, not a refusal.
          const wa = s.wireAt;
          const kind = s.pid && !wa ? 'kb-pop-div' : 'kb-echo';
          parityMiss(kind, Object.assign({ x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z), by: s.by, f: s.f, ageMs: Math.round(now - s.t) },
            s.pop ? { pop: s.pop } : {},
            s.m === undefined ? {} : { m: s.m },
            s.wt === undefined ? {} : { wt: s.wt },
            wa ? { wa: `${wa.x.toFixed(0)},${wa.y.toFixed(0)},${wa.z.toFixed(0)}`, offM: Number(Math.hypot(s.x - wa.x, s.y - wa.y, s.z - wa.z).toFixed(1)) } : {}));
        }
        stamps.splice(i, 1);
      }
    }
    if (stamps.length > 8) {stamps.shift();}
    return true;
  }

  // Apply push/pull force to local player, balls, and remote players
  function applyExplosionForce(a: BlastArgs): void {
    // NaN center/params make every `d >= radius` compare FALSE - every
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
      // same distance - rocket jumps should be viable, not lethal. Faint
      // vignette only, no hurt sound (JP: the grunt is too much for this).
      // A bot-authored blast (shooterId set) is ENEMY fire, not a rocket
      // jump - it deals full falloff damage and reports the bot as attacker.
      // A direct hit already claimed its damage through the impact path
      // (botHit → hurtLocal → envDamage). Remote targets dedupe on
      // directHitTargetId; the local branch didn't - a direct hit claimed
      // direct + splash (double damage, double rate-limit spend).
      // A self direct hit can't go through sendShot - 'local' resolves
      // to nothing server-side, so zeroing this meant shooting your feet
      // cost nothing. My own shell pays the direct amount scaled by
      // selfDamage through the env claim below (the splash pass is
      // skipped so it can't double-pay). An ENEMY shell that direct-hit
      // me is server-paid already - stay silent.
      const selfHit = a.directHitTargetId === 'local';
      const enemyBlast = a.shooterId && a.shooterId !== 'local';
      // A feet-shot launch pays up to SELF_SPLASH_MAX - same rule
      // the server charges bots, so the disc-jump is a real spend
      // for humans too. The perk still shaves it.
      let selfDmg;
      if (selfHit) {selfDmg = enemyBlast ? 0 : aoeDamage * player.mods.selfDamage;}
      else if (enemyBlast) {selfDmg = aoeDamageOf(aoeDamage, dpx, radius, scales);}
      else {selfDmg = Math.min(aoeDamageOf(aoeDamage, dpx, radius, scales) + SELF_SPLASH_MAX * (1 - dpx / radius), SELF_SPLASH_MAX) * player.mods.selfDamage;}
      if (selfDmg >= 1 && !player.isDead) {
        // Shield soaks self-splash too - the server holds health steady so
        // the only thing to report is the energy burn + its flash.
        if (player.isShielded) {
          player.absorbShieldDamage(selfDmg);
          deps.lazyHud().showShieldDamage(null, selfDmg);
          sfx.shieldHit();
        } else {
          player.lastDamageSource = enemyBlast
            ? `${a.shooterId!.replace('bot:', '')} blast`
            : 'cooked by your own blast'; // suicide reads as suicide, not "a crawler"
          // Own blast: server applies the self-splash now - claiming it
          // too would double-charge. Keep the local flash; yourHealth
          // echo corrects the bar. Enemy blasts: the same is true on
          // authoritySims() rooms - splashOne already applyDamage'd us -
          // so the claim only rides P2P (a host has no blast sweep).
          if (enemyBlast && deps.lazyNetworkManager?.()?.authoritySims?.() !== true) {
            deps.lazyNetworkManager?.()?.sendEnvironmentDamage(selfDmg, a.shooterId ?? undefined);
          }
          deps.lazyHud().showDamage(a.pos, selfDmg);
        }
      }
    }
    const kbForce = force * KNOCKBACK_SCALE;
    applyForceToBalls(Object.assign({}, a, {force: kbForce}), applyTo);
    applyForceToNuggets(pos, radius, kbForce, forceMode);
    applyForceToRemotes(a);
    // Deployables in the envelope - the offline mirror of the server's
    // applyBlast sweep (connected, remote hurt is a no-op so the call is
    // cheap prediction-side noise; blastRemotes early-outs anyway).
    {
      const wStats = a.weaponType === undefined ? undefined : getWeaponStats(a.weaponType);
      const direct = wStats ? (wStats.directDamage || wStats.aoeDamage) : aoeDamage;
      deps.lazyDeployables?.()?.blastRemotes(pos, direct, aoeDamage, radius, scales, a.weaponType, a.shooterId);
    }
    // Solo conquest nodes eat the same blast stream the Room's lattice
    // listens to - presence-raze's ranged sibling, link-gated inside.
    deps.world.soloConquest?.applyBlast(pos, aoeDamage, radius, a.shooterId, scales);
  }

  /** Blast knock on the replayed prey sims (balls + nuggets) for REMOTE-
   *  authored explosions. The authority shoves them instantly via the
   *  'prey' knock event, so a client that waits for the next segment
   *  eats ~0.5s × force of divergence - the 'segment rubberband' bursts
   *  whenever a bot blast salted a swarm. Players aren't here: the wire
   *  knockback echo + predictLocalShove own them. Damage stays server-
   *  declared (aoeDamage 0 → feedback skipped, kill edges confirm). */
  function applyForceToPrey(pos: THREE.Vector3, radius: number, force: number, forceMode: 'push' | 'pull'): void {
    if (!Number.isFinite(pos.x + pos.y + pos.z + radius + force)) {return;}
    const kbForce = force * KNOCKBACK_SCALE;
    // No BLAST_IMPULSE_MAX here - the server's prey knock is the flat,
    // uncapped dir*force envelope (knockbackForce reaches 45 on the heavy
    // launchers). The player cap exists for feel, not authority: capping
    // the prediction under-shoved prey on exactly the blasts big enough
    // to rubberband hardest.
    const applyTo = (t: Forceable, f: number): void =>
      forceMode === 'push' ? t.applyKnockback(pos, f) : t.applyPull(pos, f);
    applyForceToBalls({ pos, radius, force: kbForce, forceMode, forceMultiplier: 1, aoeDamage: 0, directHitTargetId: null }, applyTo, false);
    applyForceToNuggets(pos, radius, kbForce, forceMode);
  }

  return { applyExplosionForce, applyForceToRemotes, predictLocalShove, applyForceToPrey };
}
