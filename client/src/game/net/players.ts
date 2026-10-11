// Player lifecycle wire handlers — hit/kill/respawn/join/leave/update and
// the correction pipeline. Remote visual bookkeeping (debris, indicators,
// health bars) happens here, not in the message switchboard.

import * as THREE from 'three';
import { REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE } from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import type { ArmorClass } from '../../../../shared/botClasses.js';
import { finiteVec } from '../../../../shared/wire.js';
import { inv } from '../../../../shared/invariants.js';
import { weaponDef } from '../../weapons.js';
import { PlayerLoadout } from '../../entities/playerLoadout.js';
import { onPlayerKill } from './playerKill.js';
import { noteLocalSnap } from '../gameLoop.js';
import { initNetProbe, bindStats, attachScene, corr as probeCorr, corrGhost } from '../../debug/netProbe.js';
import { parityMiss } from '../parity.js';
import { lastWeaponByPlayer } from './projectiles.js';
import type { NetCtx } from './ctx.js';

export function wirePlayers(ctx: NetCtx): void {
  wirePlayerCombat(ctx);
  wirePlayerLifecycle(ctx);
  // NetProbe harness — stats source, ghost scene, Alt+N panel, Alt+Q section.
  initNetProbe();
  bindStats(ctx.networkManager);
  attachScene(ctx.deps.lazyScene());
}

/** Hit feedback, knockback, reconciliation, kills — the damage wire. */
function wirePlayerCombat(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;
  const {logger} = deps;

  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number, health: number, armor?: number): void => {
    if (deps.world.playbackMode) {return;}
    inv('wire-hit-finite', Number.isFinite(damage) && Number.isFinite(health), { damage, health, shooterId, targetId });
    if (!Number.isFinite(damage) || !Number.isFinite(health)) {return;}
    // Check if local player was hit
    if (targetId === nm().getLocalPlayerId()) {
      const player = deps.lazyPlayer();
      if (player.isDead) {
        // A confirmed hit on a corpse means the wire thinks we died later
        // than the sim did — worth surfacing, it moves kill credit too.
        logger.warn(`playerHit on dead local player: ${damage} from ${shooterId}`);
      }
      if (armor !== undefined && Number.isFinite(armor)) {player.armor = armor;}
      // Shielded hits route to the energy tank (server kept health
      // unchanged) — the soak reads as a cyan flash + hum, not a grunt.
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
      return;
    }

    // Non-lethal hits don't trigger death animation
    logger.info(`Remote player ${targetId} hit for ${damage} damage by ${shooterId} (health: ${health})`);
    deps.lazyHealthBarSystem().spawn(targetId, damage, health);
    deps.world.remotePlayers.get(targetId)?.flinch();
    // Server-confirmed hit on a remote: flash the marker even when client
    // prediction didn't (e.g. lag-comp rewound the victim into the shot).
    if (shooterId === nm().getLocalPlayerId()) {
      deps.lazyHud().showHitMarker();
      sfx.hitMarker(false);
    }
  };

  // Rejected claim: a predicted self-blast that never happened server-side
  // leaves our health low until the next real event. Adopt the server's
  // value so state-hash health checks stop screaming desync.
  networkManager.onShotRejected = (reason, _targetId, weaponType, health): void => {
    if (deps.world.playbackMode) {return;}
    const player = deps.lazyPlayer();
    // The authority says this pick is class-locked — a stale slot keeps
    // spam-rejecting every pull for the rest of the life. Unshoulder it
    // to the class fallback once and the next pull fires something legal.
    if (reason === 'class-locked weapon' && weaponType !== undefined) {
      for (let i = 0; i < player.loadout.length; i += 1) {
        if (weaponDef(player.loadout[i]).weaponType === weaponType) {
          player.armory.setLoadoutSlot(i, PlayerLoadout.fallbackWid(player.appliedClass, player.loadout));
          break;
        }
      }
    }
    if (health !== undefined && Number.isFinite(health) && !player.isDead) {player.health = health;}
  };

  // Server-healed hp (regen perk, mend channel, regen powerup) — arrives
  // at ~2Hz while a channel is live; adopt it wholesale, the server owns
  // these sources so its value can only ever be right.
  networkManager.onYourHealth = (health): void => {
    if (deps.world.playbackMode) {return;}
    const player = deps.lazyPlayer();
    // A NaN echo would silently poison HUD + regen math — the
    // 'hp=NaN' bug class lands here. Named, dropped.
    inv('wire-health-finite', Number.isFinite(health), { health });
    if (!Number.isFinite(health)) {return;}
    // The heal/regen channel should only ever raise hp — a drop means
    // some server-side resync is quietly writing health through the
    // wrong door, which is exactly the 'damage came from nowhere' tell.
    if (!player.isDead && health < player.health - 0.5) {
      logger.warn(`yourHealth dropped hp ${player.health} -> ${health}`);
    }
    if (!player.isDead) {player.health = health;}
  };

  // Own LG charge echo — the carrier can't see the CHARGED aura, so the
  // warning is audible: each echo crackles at the player's own position,
  // a steady sizzle while the bank is live.
  networkManager.onYourCharge = (charge): void => {
    if (deps.world.playbackMode) {return;}
    deps.world.selfCharge = charge;
    if (charge > 0) {sfx.lgSizzle(deps.lazyPlayer().pos);}
  };

  // Server tells us to apply knockback/pull to our local player
  networkManager.onKnockback = (position: { x: number; y: number; z: number }, force: number, pull?: boolean): void => {
    if (deps.world.playbackMode) {return;} // replay owns the camera's body
    inv('wire-knockback-finite', finiteVec(position) && Number.isFinite(force), { position, force });
    if (!finiteVec(position) || !Number.isFinite(force)) {return;}
    // Already predicted this blast locally at detonation — the echo would
    // double the shove. Consume the stamp and drop the message.
    const stamps = deps.world.selfBlastStamps;
    const now = performance.now();
    // Consume window = the stamp's own settle horizon (700ms in
    // blastForce) — a 400ms+ echo is still THIS blast, and a stale
    // window double-shoves then reports a false kb-echo on expiry.
    // 8m center window + force match: the replica's explode position
    // diverges from the server's blast center under drain lag (a 3m
    // match missed real echoes → double-shove + false kb-echo miss);
    // force disambiguates two blasts inside the same 700ms window.
    const i = stamps.findIndex((s): boolean => now - s.t < 700 &&
      Math.hypot(s.x - position.x, s.y - position.y, s.z - position.z) < 8 &&
      (s.f === undefined || Math.abs(s.f - force) < 0.5));
    if (i !== -1) { stamps.splice(i, 1); return; }
    const from = new THREE.Vector3(position.x, position.y, position.z);
    // A blast we RENDERED but never predicted a shove from — client-side
    // envelope/occlusion disagreed with the server's rewind, or the boom
    // had no replica at all (tripped mine). The impulse is still law;
    // it just isn't an anomaly, and the explosion already painted.
    // Only a shove with no blast anywhere near earns the log + phantom FX.
    const seen = deps.explosionTracker.getRecentExplosions()
      .some((e): boolean => Date.now() - e.timestamp < 800 && e.position.distanceTo(from) < 12)
      // A triggered mine's blast has no projectile replica and its
      // deployDown races the echo — a live mine nearby IS the blast.
      || deps.entities().deployables.mineNear(from, 12);
    if (!seen) {
      // Server shoved us from a blast we never rendered — envelope/occlusion
      // or rewind disagreed with the server. Loud parity counter — except
      // in the join window: echoes landing before our prediction window
      // existed can't be "unpredicted", they're join-race leftovers.
      if (networkManager.msSinceConnect() > 2000) {
        parityMiss('kb-unpredicted', { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z), force: Math.round(force * 10) / 10, pull: Boolean(pull) });
      }
      logger.info(`Knockback applied without prediction stamp`, { pos: position, force, pull });
      // Radius isn't on the wire; force is the only size signal we get.
      deps.lazyEffects().spawnExplosion(from, Math.max(1.5, Math.min(5, force / 8)), 12);
    }
    // Record the raw application: the echo can beat its blast's replica
    // explode (handlers run on arrival, the predicted blast waits for
    // the next projectile tick) — a delayed predicted shove at this
    // same center must then skip, or the blast lands twice.
    const rkb = deps.world.recentKb;
    rkb.push({ x: position.x, y: position.y, z: position.z, t: now, f: force });
    if (rkb.length > 8) {rkb.shift();}
    const player = deps.lazyPlayer();
    if (pull) {
      player.applyPull(from, force);
    } else {
      player.applyKnockback(from, force);
    }
  };

  // Server correction — CFWK rewind+replay, not a blunt snap:
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
    // NaN/Inf in authority state poisons the whole sim silently — a
    // malformed correction (buggy peer in p2p, server fault) gets dropped
    // instead of entering the movement controller.
    if (!finiteVec(position) || !finiteVec(velocity)) {
      logger.warn(`Correction dropped: non-finite authority vector pos=(${position.x},${position.y},${position.z})`);
      return;
    }
    const player = deps.lazyPlayer();
    const dx = player.pos.x - position.x, dy = player.pos.y - position.y, dz = player.pos.z - position.z;
    const err = (dx * dx + dy * dy + dz * dz) ** 0.5;
    // Feel over accuracy: the ignore band scales with speed — at cruise
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
    if (journal.length === 0) {
      probeCorr(err, _seq, 0, Math.hypot(player.vel.x, player.vel.y, player.vel.z), true);
      player.pos.set(position.x, position.y, position.z);
      player.vel.set(velocity.x, velocity.y, velocity.z);
      // Render ease hides the jolt — the camera eases the jump over
      // ~100ms while the sim is already converged.
      player.noteRenderSnap(new THREE.Vector3(position.x - prePos.x, position.y - prePos.y, position.z - prePos.z));
      noteLocalSnap();
      // NEVER touch yaw/pitch — the server echoes our last *accepted*
      // rotation, which can be seconds stale. Aim is client-authoritative;
      // snapping it warps the camera 40-60° for no gameplay reason.
      player.syncMovement();
      return;
    }
    // Rewind the shared sim to server truth. Yaw stays ours — aim is
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

  // Declared remote teleport (another player's warp): snap the visual —
  // interpolating across a 50m gap reads as a rocket-flight glitch
  networkManager.onRemoteTeleport = (playerId: string, position: { x: number; y: number; z: number }, _velocity: { x: number; y: number; z: number }): void => {
    const rp = deps.world.remotePlayers.get(playerId);
    if (!rp) {return;}
    // teleportTo writes straight into position/previousPosition/interp — a
    // non-finite wire value would poison the remote's whole motion state.
    if (!finiteVec(position)) {
      logger.warn(`remoteTeleport ${playerId} dropped: non-finite position`);
      return;
    }
    rp.teleportTo(new THREE.Vector3(position.x, position.y, position.z));
  };

  networkManager.onPlayerKill = (shooterId, targetId, weapon, air): void => onPlayerKill(ctx, shooterId, targetId, weapon, air);
}

/** Updates, respawns, join/leave, movement events — the presence wire. */
function wirePlayerLifecycle(ctx: NetCtx): void {
  const { deps, networkManager, nm, ensureRemotePlayer } = ctx;
  const {logger} = deps;

  networkManager.onPlayerJump = (_playerId: string, position: { x: number; y: number; z: number }): void => {
    if (!finiteVec(position)) {return;} // non-finite wire pos would poison the particle pool
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJumpDust(pos);
  };

  networkManager.onPlayerJetpack = (_playerId: string, position: { x: number; y: number; z: number }): void => {
    if (!finiteVec(position)) {return;}
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJetpack(pos);
  };

  networkManager.onPlayerUpdate = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, serverMs: number, velocity?: { x: number; y: number; z: number }): void => {
    // Safety: never process local player as a remote player
    if (playerId === nm().getLocalPlayerId()) {return;}
    const remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.update(position, rotation, REMOTE_PLAYER_FIXED_DT, nm().getPing(), velocity, serverMs);
      if (Math.random() < DEBUG_LOG_SAMPLE_RATE) { // 5% of updates log for debugging
        logger.debug(`onPlayerUpdate: ${playerId} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`);
      }
      return;
    }

    // Don't create RemotePlayer for dead players — wait for respawn event.
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
      // The respawn carries the class the server actually banked — trust
      // it over the local pick or a dropped classUpdate leaves the client
      // shouldering ordnance the authority still calls class-locked.
      if (armorClass) {player.armorClass = armorClass as ArmorClass;}
      player.resetLifeState();
      // A non-finite respawn pos would poison pos/lastSentPos/movement —
      // the same wire-ingest class gated everywhere else on this lane.
      if (!finiteVec(position)) {
        logger.warn(`local respawn dropped: non-finite position`);
        return;
      }
      player.pos.set(position.x, position.y, position.z);
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

  networkManager.onPlayerLeft = (playerId: string): void => {
    if (deps.world.remotePlayers.remove(playerId)) {
      logger.info(`Remote player removed (playerLeft): ${playerId}`);
    }
    // Alt+w fire ledger is keyed per id — a churned roster grows dead
    // ids forever otherwise.
    lastWeaponByPlayer.delete(playerId);
  };
}
