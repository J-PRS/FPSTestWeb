// Player lifecycle wire handlers - hit/kill/respawn/join/leave/update and
// the correction pipeline. Remote visual bookkeeping (debris, indicators,
// health bars) happens here, not in the message switchboard.

import * as THREE from 'three';
import { REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE } from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import type { ArmorClass } from '../../../../shared/botClasses.js';
import { finiteVec } from '../../../../shared/wire.js';
import { inv } from '../../../../shared/invariants.js';
import { weaponDef } from '../../weapons.js';
import { onPlayerKill } from './playerKill.js';
import { noteLocalSnap } from '../gameLoop.js';
import { initNetProbe, bindStats, attachScene, corr as probeCorr, corrGhost } from '../../debug/netProbe.js';
import { parityMiss, kbEchoHorizon, kbStampDeadline } from '../parity.js';
import { recCorrection } from '../../core/telemetry.js';
import { lastWeaponByPlayer } from './projectiles.js';
import { markLocalSeated, isSessionVeiled } from './world.js';
import { setIntel } from '../intel.js';
import type { NetCtx } from './ctx.js';

/** Updates, respawns, join/leave, movement events - the presence wire. */
function wirePlayerLifecycle(ctx: NetCtx): void {
  const { deps, networkManager, nm, ensureRemotePlayer } = ctx;
  const {logger} = deps;

  networkManager.onPlayerJump = (_playerId: string, position: { x: number; y: number; z: number }): void => {
    if (!finiteVec(position)) {return;} // non-finite wire pos would poison the particle pool
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJumpDust(pos);
  };

  networkManager.onPlayerJetpack = (playerId: string, position: { x: number; y: number; z: number }): void => {
    if (!finiteVec(position)) {return;} // non-finite wire pos would poison the particle pool
    // The sustained plume already comes off the per-tick held-jet wire bit
    // (tickRemoteCosmetics → emitLocomotionFx); emitting here too would double
    // its density over the local player's. Keep it only as the fallback for a
    // sender whose frames omit that bit, so every remote burns one plume.
    if (nm().getPlayers().get(playerId)?.jet) {return;}
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJetpack(pos);
  };

  networkManager.onLanded = (playerId: string, position: { x: number; y: number; z: number }, impact: number): void => {
    // The owner predicted their own thud/dust off the local sim -
    // echoing the wire copy back at them would double the hit.
    if (playerId === nm().getLocalPlayerId()) {return;}
    if (!finiteVec(position) || !Number.isFinite(impact)) {return;}
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    sfx.at(pos, 'slam_thud', Math.min(1.2, Math.max(0.4, impact / 60)));
    deps.lazyEffects().spawnSlamDust(pos, impact);
  };

  networkManager.onPlayerUpdate = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, serverMs: number, velocity?: { x: number; y: number; z: number }): void => {
    // Safety: never process local player as a remote player
    if (playerId === nm().getLocalPlayerId()) {return;}
    const remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      // Roster truth gates the feed: dead rows keep streaming position
      // echoes through the corpse window, and update()'s revive-on-update
      // would ping-pong dead↔alive off each one (gib spam, flailing
      // corpse). The row is patched from this same message before this
      // callback runs, so isDead here is already current. A live row
      // still revives a stale-dead entity — the dropped-respawn-echo case.
      if (nm().getPlayers().get(playerId)?.isDead) {return;}
      remotePlayer.update(position, rotation, REMOTE_PLAYER_FIXED_DT, nm().getPing(), velocity, serverMs);
      if (Math.random() < DEBUG_LOG_SAMPLE_RATE) { // 5% of updates log for debugging
        logger.debug(`onPlayerUpdate: ${playerId} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`);
      }
      return;
    }

    // Don't create RemotePlayer for dead players - wait for respawn event.
    // Absent record = departed (playerLeft purges the roster row): a stale
    // update racing the delete must not resurrect a phantom remote.
    const playerData = nm().getPlayers().get(playerId);
    if (!playerData || playerData.isDead) {return;}
    logger.debug(`onPlayerUpdate called for unknown player: ${playerId}, creating...`);
    ensureRemotePlayer(playerId, position, 'onPlayerUpdate');
  };

  networkManager.onPlayerRespawn = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, armorClass?: string): void => {
    if (deps.world.playbackMode) {return;}
    // Check if local player respawned
    if (playerId === nm().getLocalPlayerId()) {
      logger.info(`Local player respawned at ${JSON.stringify(position)}`);
      const player = deps.lazyPlayer();
      // The respawn carries the class the server actually banked - trust
      // it over the local pick or a dropped classUpdate leaves the client
      // shouldering ordnance the authority still calls class-locked.
      if (armorClass) {player.armorClass = armorClass as ArmorClass;}
      player.resetLifeState();
      // A non-finite respawn pos would poison pos/lastSentPos/movement -
      // the same wire-ingest class gated everywhere else on this lane.
      if (!finiteVec(position)) {
        logger.warn(`local respawn dropped: non-finite position`);
        return;
      }
      player.pos.set(position.x, position.y, position.z);
      markLocalSeated();
      if (!isSessionVeiled()) {nm().sendReady();} // veil-less seats release the spawn-hold immediately; held-or-not, 'ready' no-ops
      noteLocalSnap();
      deps.setLastSentPos({ x: position.x, y: position.y, z: position.z });
      if (Number.isFinite(rotation.yaw + rotation.pitch)) {
        player.yaw = rotation.yaw;
        player.pitch = rotation.pitch;
      }
      player.syncMovement(); // reseat controller or its snapshot overwrites the respawn
      player.markTeleport(); // spawn point can sit >50m from the corpse
      deps.lazyHud().show();
      deps.lazyHud().setDeathOverlay(false);
      return;
    }

    // Reset existing remote player on respawn
    if (!finiteVec(position)) {
      logger.warn(`remote respawn ${playerId} dropped: non-finite position`);
      return;
    }
    const remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      const playerData = nm().getPlayers().get(playerId);
      const internalId = playerData?.internalId || 'unknown';
      if (armorClass) {remotePlayer.setClass(armorClass);} // respawn may carry a banked tier swap
      remotePlayer.respawn(position);
      logger.info(`Player ${playerId} (internalId: ${internalId}) respawned at ${JSON.stringify(position)}`);
    } else {
      // Create new remote player if they don't exist (shouldn't happen but safety check)
      ensureRemotePlayer(playerId, position, 'onPlayerRespawn');
    }
  };

  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, _rotation: { yaw: number; pitch: number }): void => {
    if (deps.world.playbackMode) {return;}
    // Safety: server excludes self from playerJoined broadcast, but guard anyway
    if (playerId === nm().getLocalPlayerId()) {return;}
    const playerData = nm().getPlayers().get(playerId);
    const internalId = playerData?.internalId || 'unknown';
    const terrainHeight = deps.lazyTerrain().getHeight(position.x, position.z);
    const aboveTerrain = position.y >= terrainHeight;
    logger.info(`Player joined: ${playerId} (internalId: ${internalId}) at ${JSON.stringify(position)} | Terrain height: ${terrainHeight.toFixed(1)} | ${aboveTerrain ? '✓ Above/at terrain' : '✗ BELOW TERRAIN'}`);
    // RemotePlayer will be created in the main loop when networkManager.getPlayers() includes this player
  };

  // Headhunt: the local count never lives in the remote roster - the
  // roster half was already patched by the dispatcher.
  networkManager.onPlayerHeld = (playerId: string, n: number): void => {
    if (playerId === nm().getLocalPlayerId()) {deps.lazyPlayer().heldTokens = n;}
  };

  networkManager.onPlayerLeft = (playerId: string): void => {
    if (deps.world.remotePlayers.remove(playerId)) {
      logger.info(`Remote player removed (playerLeft): ${playerId}`);
    }
    // Alt+w fire ledger is keyed per id - a churned roster grows dead
    // ids forever otherwise.
    lastWeaponByPlayer.delete(playerId);
  };
}



/** Wire playerHit → health/death feedback + the demo's damage edge. */
function handleWireHit(ctx: NetCtx, shooterId: string, targetId: string, damage: number, health: number, opts?: { armor?: number; predicted?: boolean }): void {
  const armor = opts?.armor;
  const predicted = opts?.predicted;
  const { deps, nm } = ctx;
  const {logger} = deps;
  if (deps.world.playbackMode) {return;}
  inv('wire-hit-finite', Number.isFinite(damage) && Number.isFinite(health), { damage, health, shooterId, targetId });
  if (!Number.isFinite(damage) || !Number.isFinite(health)) {return;}
  recordWireHitDemo(ctx, shooterId, targetId, damage);
  if (targetId === nm().getLocalPlayerId()) {wireHitSelf(ctx, shooterId, damage, health, armor); return;}

  // Non-lethal hits don't trigger death animation
  logger.info(`Remote player ${targetId} hit for ${damage} damage by ${shooterId} (health: ${health})`);
  deps.lazyHealthBarSystem().spawn(targetId, damage, health, armor);
  deps.world.remotePlayers.get(targetId)?.flinch();
  // Server-confirmed hit on a remote: flash the marker even when client
  // prediction didn't (e.g. lag-comp rewound the victim into the shot).
  if (shooterId === nm().getLocalPlayerId()) {confirmLocalHit(ctx, targetId, damage, predicted);}
}

/** Every credited hit lands in the demo - demodiff pairs it 1:1 with
 *  the server's own playerHit edge; a missing one is a dropped wire
 *  event (the "no missing damage" oracle). */
function recordWireHitDemo(ctx: NetCtx, shooterId: string, targetId: string, damage: number): void {
  const { deps, nm } = ctx;
  const hitPos = targetId === nm().getLocalPlayerId()
    ? deps.lazyPlayer().pos
    : (deps.world.remotePlayers.get(targetId)?.pos ?? deps.lazyPlayer().pos);
  deps.lazyDemoManager?.()?.recordPlayerHit(shooterId === 'environment' ? null : shooterId, targetId, damage, hitPos);
}

/** Our own shot echoed back: hitmarker + damage number unless the client
 *  already predicted it (double-paint reads as double damage). */
function confirmLocalHit(ctx: NetCtx, targetId: string, damage: number, predicted?: boolean): void {
  const { deps } = ctx;
  // Authority-simmed shells never run the client's predict path, so
  // the damage number has to live on the echo or it never appears.
  const rp = deps.world.remotePlayers.get(targetId);
  if (rp && !predicted) {deps.lazyDamageNumbers().spawn(rp.pos, damage, '#ffe08a', deps.lazyCamera());}
  deps.lazyHud().showHitMarker();
  sfx.hitMarker(false);
}

/** playerHit on the LOCAL seat - corpse-revive, shield soak, hurt feedback. */
function wireHitSelf(ctx: NetCtx, shooterId: string, damage: number, health: number, armor?: number): void {
  const { deps } = ctx;
  const {logger} = deps;
  const player = deps.lazyPlayer();
  if (player.isDead) {
    if (player.deadConfirmedByWire) {
      // A confirmed hit on a corpse means the wire thinks we died later
      // than the sim did - worth surfacing, it moves kill credit too.
      logger.warn(`playerHit on dead local player: ${damage} from ${shooterId}`);
    } else {
      // Predicted death, never wire-confirmed - the server says we're
      // alive and this hit IS the proof. Un-die to its health so the
      // seat un-bricks instead of desyncing isDead until a kill lands.
      logger.warn(`playerHit on predicted-dead local - reviving to server hp ${health} (was dead to ${shooterId})`);
      player.isDead = false;
      player.health = health;
      deps.lazyHud().show();
      deps.lazyHud().setDeathOverlay(false);
    }
  }
  if (armor !== undefined && Number.isFinite(armor)) {player.armor = armor;}
  // Shielded hits route to the energy tank (server kept health
  // unchanged) - the soak reads as a cyan flash + hum, not a grunt.
  if (player.isShielded) {
    player.absorbShieldDamage(damage);
    deps.lazyHud().showShieldDamage(deps.world.remotePlayers.get(shooterId)?.pos ?? null, damage);
    sfx.shieldHit();
    player.health = health;
    logger.info(`Shield soaked ${damage} from ${shooterId} (health: ${health})`);
    return;
  }
  player.health = health;
  // Point the damage arc at the shooter's last known position
  deps.lazyHud().showDamage(deps.world.remotePlayers.get(shooterId)?.pos ?? null, damage);
  sfx.playerHurt();
  logger.info(`Local player hit for ${damage} damage by ${shooterId} (health: ${health})`);
}

/** Wire knockback/pull → local impulse - prediction-stamp consumption,
 *  residual top-up, unpredicted-shove ledger. */
function wireKnockback(ctx: NetCtx, position: { x: number; y: number; z: number }, force: number, pull?: boolean, yank?: boolean): void {
  const { deps, networkManager } = ctx;
  const {logger} = deps;
  if (deps.world.playbackMode) {return;} // replay owns the camera's body
  inv('wire-knockback-finite', finiteVec(position) && Number.isFinite(force), { position, force });
  if (!finiteVec(position) || !Number.isFinite(force)) {return;}
  // Already predicted this blast locally at detonation - the echo would
  // double the shove. Consume the stamp and drop the message.
  const stamps = deps.world.selfBlastStamps;
  const now = performance.now();
  // Settle overdue stamps here too - blastForce only sweeps when a NEW
  // self shove lands, so without this an unechoed stamp sat for minutes
  // and reported its kb-echo on the next blast, not on its own expiry.
  // Starvation-tolerant expiry: a wire stall delays every echo, so a
  // stamp younger than (horizon + current silence) can't have been
  // refused yet - expiring it mid-stall strands the late echo into a
  // raw apply (double-shove) AND logs a false kb-echo.
  const kbHorizon = kbEchoHorizon(networkManager.serverPingMs ?? networkManager.getPing(), networkManager.msSinceLiveRx());
  for (let i = stamps.length - 1; i >= 0; i -= 1) {
    if (now > kbStampDeadline(stamps[i]!, kbHorizon)) {
      // Self-authored stamps are confirmation-free (the server skips
      // its self-shove for humans) - silent expiry; only remote-blast
      // predictions audit an echo that should have existed.
      if (!stamps[i]!.self) {
        const s = stamps[i]!;
        // Refused verdict - undo the predicted impulse: the drift already
        // integrated can't un-run, but reverting vel stops the phantom
        // shove from compounding into the next envelope eval.
        if (s.iv) {const v = deps.lazyPlayer().vel; if (v) {v.x -= s.iv.x; v.y -= s.iv.y; v.z -= s.iv.z;}}
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
  // Consume window = the stamp's own settle horizon (700ms in
  // blastForce) - a 400ms+ echo is still THIS blast, and a stale
  // window double-shoves then reports a false kb-echo on expiry.
  // Identity = center+time; force only DISAMBIGUATES candidates. The
  // wire force is the server's rewind-epoch applied impulse - under
  // latency the boundary-falloff prediction differs legitimately, and
  // a hard <0.5 veto orphans the match (double-shove + a false
  // kb-echo expiry + the echo re-warned as kb-unpredicted).
  // Center window widened 8→18m: the stamped center is the replica's
  // painted blast point - with trajDiv p95 ~25m the wire's detonation
  // center can sit well outside it. A miss here double-shoves (predicted
  // impulse + full wire impulse) AND orphans the stamp into a false
  // kb-echo. Force disambiguates two same-window blasts.
  const cands: number[] = [];
  for (let k = 0; k < stamps.length; k += 1) {
    const s = stamps[k]!;
    if (now <= kbStampDeadline(s, kbHorizon) && Math.hypot(s.x - position.x, s.y - position.y, s.z - position.z) < 18) {cands.push(k);}
  }
  let i = cands.length === 0 ? -1
    : cands.reduce((a, b): number => Math.abs((stamps[a]!.f ?? force) - force) <= Math.abs((stamps[b]!.f ?? force) - force) ? a : b);
  // Unambiguous fallback: exactly ONE pending stamp in the horizon -
  // the wire echo has to be its pair regardless of how far the replica's
  // painted center diverged (>18m in the trajDiv tail). Not consuming
  // here is the physical double-shove + a false kb-echo expiry; with
  // 2+ pending the attribution genuinely can't be called, so hold.
  if (i === -1) {
    const pending = stamps.filter((s): boolean => now <= kbStampDeadline(s, kbHorizon));
    if (pending.length === 1) {i = stamps.indexOf(pending[0]!);}
  }
  if (i !== -1) {
    // Same blast, already predicted - but the wire carries the server's
    // applied impulse, which wins. Residual-only: a positive delta tops
    // up the prediction; an overshoot is left to the shadow correction
    // (impulses can't be un-applied through this path).
    const delta = force - (stamps[i]!.f ?? force);
    stamps.splice(i, 1);
    if (delta > 0.5) {
      const dpos = new THREE.Vector3(position.x, position.y, position.z);
      const player = deps.lazyPlayer();
      if (pull) {player.applyPull(dpos, delta, yank);} else {player.applyKnockback(dpos, delta);}
    }
    return;
  }
  const from = new THREE.Vector3(position.x, position.y, position.z);
  // A blast we RENDERED but never predicted a shove from - client-side
  // envelope/occlusion disagreed with the server's rewind, or the boom
  // had no replica at all (tripped mine). The impulse is still law;
  // it just isn't an anomaly, and the explosion already painted.
  // Only a shove with no blast anywhere near earns the log + phantom FX.
  const seen = deps.explosionTracker.getRecentExplosions()
    // 800ms was too tight: wire shove echoes systematically land ~1s
    // after the stamped blast (kb-echo ageMs ~1014-3016 observed), so a
    // legit remote blast expired out of the window and every shove read
    // as an orphan - warn + phantom boom on top of the real one.
    .some((e): boolean => Date.now() - e.timestamp < 1500 && e.position.distanceTo(from) < 12)
    // A triggered mine's blast has no projectile replica and its
    // deployDown races the echo - a live mine nearby IS the blast.
    || deps.entities().deployables.mineNear(from, 12);
  // A rope-dart yank IS an unpredicted shove by design (the reeled
  // victim never predicted a blast) - no phantom boom, no ledger entry.
  if (!seen && !yank) {
    // Blast edge may simply trail the knockback under jitter - hold the
    // shove; addExplosion redeems it. Only an expiry warns.
    deps.explosionTracker.shoveArrived(position.x, position.y, position.z, force, Boolean(pull));
    logger.info(`Knockback applied without prediction stamp`, { pos: position, force, pull });
    // Radius isn't on the wire; force is the only size signal we get.
    deps.lazyEffects().spawnExplosion(from, Math.max(1.5, Math.min(5, force / 8)), 12);
  }
  // Sweeps happen on each knockback - a shove whose blast never landed
  // in grace is the real invisible-force anomaly. Join-race leftovers
  // (echoes older than our prediction window) can't be "unpredicted".
  for (const s of deps.explosionTracker.expiredShoves(Date.now())) {
    if (networkManager.msSinceConnect() > 2000) {
      parityMiss('kb-unpredicted', { x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z), force: Math.round(s.force * 10) / 10, pull: s.pull });
    }
  }
  // Record the raw application: the echo can beat its blast's replica
  // explode (handlers run on arrival, the predicted blast waits for
  // the next projectile tick) - a delayed predicted shove at this
  // same center must then skip, or the blast lands twice.
  const rkb = deps.world.recentKb;
  rkb.push({ x: position.x, y: position.y, z: position.z, t: now, f: force });
  if (rkb.length > 8) {rkb.shift();}
  const player = deps.lazyPlayer();
  if (pull) {
    player.applyPull(from, force, yank);
  } else {
    player.applyKnockback(from, force);
  }
}

/** The server never spawned this shell - the predicted fake must die
 *  silently or it flies on and explodes solo (the ghost-shot class).
 *  Fan pulls reject under the PULL nonce: pellets keyed their own
 *  shotIds, so the pull id only resolves through unbound fan slots
 *  (a rejected intent never echoes creates, so nothing bound yet). */
function killPredictedShell(deps: NetCtx['deps'], shotId: string | undefined): void {
  if (!shotId) {return;}
  const shell = deps.world.projectileRegistry.byShotId.get(shotId);
  if (shell && !shell.dead) {shell.dead = true;}
  if (shell) {return;}
  for (const [slot, pellet] of deps.world.projectileRegistry.byFanSlot) {
    if (slot.startsWith(`${shotId}#`) && !pellet.dead) {pellet.dead = true;}
  }
}

/** Rejected-claim handler factory - owns the class-resync throttle.
 *  A predicted self-blast that never happened server-side leaves our
 *  health low until the next real event; adopt the server's value so
 *  state-hash health checks stop screaming desync. */
function makeShotRejectedHandler(ctx: NetCtx, networkManager: NetCtx['networkManager']): NonNullable<NetCtx['networkManager']['onShotRejected']> {
  const { deps } = ctx;
  let lastClassResync = 0;
  return (reason, _targetId, weaponType, health, shotId): void => {
    if (deps.world.playbackMode) {return;}
    const player = deps.lazyPlayer();
    killPredictedShell(deps, shotId);
    // The authority says this pick is class-locked - a stale slot keeps
    // spam-rejecting every pull for the rest of the life. Unshoulder it
    // to the class fallback once and the next pull fires something legal.
    // unshoulderLiveSlot, not setLoadoutSlot: a banked class swap would
    // redirect the write into pendingLoadout and the live gun never heals.
    if (reason === 'class-locked weapon' && weaponType !== undefined) {
      for (let i = 0; i < player.loadout.length; i += 1) {
        if (weaponDef(player.loadout[i]).weaponType === weaponType) {
          player.armory.unshoulderLiveSlot(i);
          break;
        }
      }
      // The authority's enforced tier disagrees with the one we're
      // playing - re-bank appliedClass so pendingClass stops lying at
      // the next respawn. Throttled: a locked spray rejects per pull.
      const now = performance.now();
      if (now - lastClassResync > 2000) {
        lastClassResync = now;
        networkManager.sendClassUpdate(player.appliedClass);
      }
    }
    if (health !== undefined && Number.isFinite(health) && !player.isDead) {player.health = health;}
  };
}

/** Hit feedback, knockback, reconciliation, kills - the damage wire. */
function wirePlayerCombat(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;
  const {logger} = deps;

  networkManager.onPlayerHit = (shooterId, targetId, damage, health, armor, predicted): void =>
    handleWireHit(ctx, shooterId, targetId, damage, health, { armor, predicted });

  networkManager.onShotRejected = makeShotRejectedHandler(ctx, networkManager);

  // Server-healed hp (regen perk, mend channel, regen powerup) - arrives
  // at ~2Hz while a channel is live; adopt it wholesale, the server owns
  // these sources so its value can only ever be right.
  networkManager.onYourHealth = (health, armor): void => {
    if (deps.world.playbackMode) {return;}
    const player = deps.lazyPlayer();
    // A NaN echo would silently poison HUD + regen math - the
    // 'hp=NaN' bug class lands here. Named, dropped.
    inv('wire-health-finite', Number.isFinite(health), { health });
    if (!Number.isFinite(health)) {return;}
    // The heal/regen channel should only ever raise hp - a drop means
    // some server-side resync is quietly writing health through the
    // wrong door, which is exactly the 'damage came from nowhere' tell.
    if (!player.isDead && health < player.health - 0.5) {
      logger.warn(`yourHealth dropped hp ${player.health} -> ${health}`);
    }
    if (!player.isDead) {player.health = health;}
    if (armor !== undefined && Number.isFinite(armor)) {player.armor = armor;}
  };

  // Own LG charge echo - the carrier can't see the CHARGED aura, so the
  // warning is audible: each echo crackles at the player's own position,
  // a steady sizzle while the bank is live.
  networkManager.onYourCharge = (charge): void => {
    if (deps.world.playbackMode) {return;}
    deps.world.selfCharge = charge;
    if (charge > 0) {sfx.lgSizzle(deps.lazyPlayer().pos);}
  };

  // Pool ammo echo - the server owns the debit ledger, so its count is
  // truth: stamp each cell at arrival and let the shared accrual resume.
  networkManager.onYourAmmo = (rows): void => {
    if (deps.world.playbackMode) {return;}
    const player = deps.lazyPlayer();
    const t = performance.now() / 1000;
    for (const [wt, n] of rows) {player.ammoPool.set(wt, { ammo: n, t, shotAt: -Infinity });}
  };

  // Server tells us to apply knockback/pull to our local player
  networkManager.onKnockback = (position, force, pull, yank): void =>
    wireKnockback(ctx, position, force, pull, yank);

  // Server correction - CFWK rewind+replay, not a blunt snap:
  //  <0.5m error  → ignore: the prediction error is sub-visible, replaying
  //                 would be a worse warp than the desync it fixes
  //  ≥0.5m        → rewind the sim to the server's state, then replay every
  //                 journaled input the server hadn't consumed yet (inputSeq)
  //                 so our converged position already includes what we did
  //                 during the round trip. No replay data (old server) →
  //                 hard snap fallback.
  networkManager.onCorrection = (_seq: number, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, inputSeq?: number, grounded?: boolean): void => {
    // During demo playback corrections fire constantly (recorded positions
    // desync from what the server last accepted) and would warp the replay.
    if (deps.world.playbackMode) {return;}
    // NaN/Inf in authority state poisons the whole sim silently - a
    // malformed correction (buggy peer in p2p, server fault) gets dropped
    // instead of entering the movement controller.
    if (!finiteVec(position) || !finiteVec(velocity)) {
      logger.warn(`Correction dropped: non-finite authority vector pos=(${position.x},${position.y},${position.z})`);
      return;
    }
    const player = deps.lazyPlayer();
    const dx = player.pos.x - position.x, dy = player.pos.y - position.y, dz = player.pos.z - position.z;
    const err = (dx * dx + dy * dy + dz * dz) ** 0.5;
    // Feel over accuracy: the ignore band scales with speed - at cruise
    // a ~5m snap is 0.1s of travel (invisible), at standstill ~1.2m
    // still reads. The server suppresses the same band; drift stays
    // inside both budgets so convergence never starves.
    const snapFloor = Math.max(1.2, Math.hypot(player.vel.x, player.vel.y, player.vel.z) * 0.1);
    if (err < snapFloor) {
      logger.info(`Correction ignored: ${err.toFixed(2)}m below snap threshold`);
      return;
    }
    // NetProbe: record the delta + ghost the truth-vs-predicted gap
    // BEFORE the snap moves player.pos.
    const prePos = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
    corrGhost(position, prePos);
    // gapMs = the round-trip the correction rode: the still-held input
    // must replay across it or steady-key corrections hard-snap.
    const journal = inputSeq === undefined ? [] : nm().inputsAfter(inputSeq, nm().getPing());
    recCorrection(err, nm().getPing(), journal.length, journal.length === 0);
    if (journal.length === 0) {
      probeCorr(err, _seq, 0, Math.hypot(player.vel.x, player.vel.y, player.vel.z), true);
      player.pos.set(position.x, position.y, position.z);
      player.vel.set(velocity.x, velocity.y, velocity.z);
      // Render ease hides the jolt - the camera eases the jump over
      // ~100ms while the sim is already converged.
      player.noteRenderSnap(new THREE.Vector3(position.x - prePos.x, position.y - prePos.y, position.z - prePos.z));
      noteLocalSnap();
      // NEVER touch yaw/pitch - the server echoes our last *accepted*
      // rotation, which can be seconds stale. Aim is client-authoritative;
      // snapping it warps the camera 40-60° for no gameplay reason.
      player.syncMovement();
      return;
    }
    // Rewind the shared sim to server truth. Yaw stays ours - aim is
    // client-authoritative and the echoed rotation can be seconds stale.
    player.movement.setState({
      pos: new THREE.Vector3(position.x, position.y, position.z),
      vel: new THREE.Vector3(velocity.x, velocity.y, velocity.z),
      yaw: player.yaw, pitch: player.pitch,
      onGround: grounded ?? true,
    });
    // Entry i's input governed [t_i, t_{i+1}); clamp segment dt so a stale
    // journal can't produce a giant catch-up step.
    const now = performance.now();
    for (let i = 0; i < journal.length; i += 1) {
      const e = journal[i];
      const nextT = i + 1 < journal.length ? journal[i + 1].t : now;
      player.movement.setInput({
        forward: e.input.forward, right: e.input.right,
        jumpPressed: Boolean(e.input.jump), jumpHeld: Boolean(e.input.jump),
        skiHeld: Boolean(e.input.ski), jetHeld: Boolean(e.input.jet),
      });
      player.movement.update(Math.min(0.25, Math.max(0, (nextT - e.t) / 1000)));
    }
    const st = player.movement.getState();
    player.pos.set(st.pos.x, st.pos.y, st.pos.z);
    player.vel.set(st.vel.x, st.vel.y, st.vel.z);
    player.onGround = st.onGround;
    player.noteRenderSnap(new THREE.Vector3(st.pos.x - prePos.x, st.pos.y - prePos.y, st.pos.z - prePos.z));
    noteLocalSnap();
    player.syncMovement();
    probeCorr(err, _seq, journal.length, Math.hypot(st.vel.x, st.vel.y, st.vel.z), false);
    logger.info(`Correction replayed: ${err.toFixed(2)}m err, ${journal.length} inputs from seq ${inputSeq}`);
  };

  // Declared remote teleport (another player's warp): snap the visual -
  // interpolating across a 50m gap reads as a rocket-flight glitch
  networkManager.onRemoteTeleport = (playerId: string, position: { x: number; y: number; z: number }, _velocity: { x: number; y: number; z: number }): void => {
    const rp = deps.world.remotePlayers.get(playerId);
    if (!rp) {return;}
    // teleportTo writes straight into position/previousPosition/interp - a
    // non-finite wire value would poison the remote's whole motion state.
    if (!finiteVec(position)) {
      logger.warn(`remoteTeleport ${playerId} dropped: non-finite position`);
      return;
    }
    rp.teleportTo(new THREE.Vector3(position.x, position.y, position.z));
  };

  networkManager.onPlayerKill = (shooterId, targetId, weapon, air, steal): void => onPlayerKill(ctx, shooterId, targetId, weapon, air, steal);

  // Server-truth IFF feed - the marker gate reads this store; nothing
  // else may un-hide an enemy indicator.
  networkManager.onIntel = (seen, mem): void => setIntel(seen, mem);
}



export function wirePlayers(ctx: NetCtx): void {
  wirePlayerCombat(ctx);
  wirePlayerLifecycle(ctx);
  // NetProbe harness - stats source, ghost scene, Alt+N panel, Alt+Q section.
  initNetProbe();
  bindStats(ctx.networkManager);
  attachScene(ctx.deps.lazyScene());
}
