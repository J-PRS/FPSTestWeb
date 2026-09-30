// Player lifecycle wire handlers — hit/kill/respawn/join/leave/update and
// the correction pipeline. Remote visual bookkeeping (debris, indicators,
// health bars) happens here, not in the message switchboard.

import * as THREE from 'three';
import { REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE } from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import { PlayerDebris } from '../../effects/debris.js';
import { TEAM_COLORS } from '../../../../shared/teams.js';
import type { ArmorClass } from '../../../../shared/botClasses.js';
import { noteKill } from '../../core/stateDebug.js';
import type { NetCtx } from './ctx.js';

export function wirePlayers(ctx: NetCtx): void {
  wirePlayerCombat(ctx);
  wirePlayerLifecycle(ctx);
}

/** Tribes streak titles by kills-since-death — subtitle under the frag
 *  headline at 3/5/7/10. */
const STREAK_NAMES: [number, string][] = [
  [10, 'GODLIKE'], [7, 'UNSTOPPABLE'], [5, 'RAMPAGE'], [3, 'KILLING SPREE'],
];

/** Hit feedback, knockback, reconciliation, kills — the damage wire. */
function wirePlayerCombat(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;
  const logger = deps.logger;
  const streak = { v: 0 }; // kills since last local death — reset inside the kill handler

  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number, health: number, armor?: number) => {
    if (deps.world.playbackMode) return;
    // Check if local player was hit
    if (targetId === nm().getLocalPlayerId()) {
      const player = deps.lazyPlayer();
      if (armor !== undefined) player.armor = armor;
      // Shielded hits route to the energy tank (server kept health
      // unchanged) — the soak reads as a cyan flash + hum, not a grunt.
      if (player.isShielded) {
        player.absorbShieldDamage(damage);
        deps.lazyHud().showShieldDamage(deps.world.remotePlayers.get(shooterId)?.pos ?? null, damage);
        sfx.shieldHit();
        player.health = health;
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
  networkManager.onShotRejected = (_reason, _targetId, _weaponType, health) => {
    if (deps.world.playbackMode || health === undefined) return;
    const player = deps.lazyPlayer();
    if (!player.isDead) player.health = health;
  };

  // Server-healed hp (regen perk, mend channel, regen powerup) — arrives
  // at ~2Hz while a channel is live; adopt it wholesale, the server owns
  // these sources so its value can only ever be right.
  networkManager.onYourHealth = (health) => {
    if (deps.world.playbackMode) return;
    const player = deps.lazyPlayer();
    if (!player.isDead) player.health = health;
  };

  // Own LG charge echo — the carrier can't see the CHARGED aura, so the
  // warning is audible: each echo crackles at the player's own position,
  // a steady sizzle while the bank is live.
  networkManager.onYourCharge = (charge) => {
    if (deps.world.playbackMode) return;
    deps.world.selfCharge = charge;
    if (charge > 0) sfx.lgSizzle(deps.lazyPlayer().pos);
  };

  // Server tells us to apply knockback/pull to our local player
  networkManager.onKnockback = (position: { x: number; y: number; z: number }, force: number, pull?: boolean) => {
    if (deps.world.playbackMode) return; // replay owns the camera's body
    // Already predicted this blast locally at detonation — the echo would
    // double the shove. Consume the stamp and drop the message.
    const stamps = deps.world.selfBlastStamps;
    const now = performance.now();
    const i = stamps.findIndex(s => now - s.t < 400 &&
      Math.hypot(s.x - position.x, s.y - position.y, s.z - position.z) < 3);
    if (i >= 0) { stamps.splice(i, 1); return; }
    const from = new THREE.Vector3(position.x, position.y, position.z);
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
  networkManager.onCorrection = (_seq: number, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, inputSeq?: number, grounded?: boolean) => {
    // During demo playback corrections fire constantly (recorded positions
    // desync from what the server last accepted) and would warp the replay.
    if (deps.world.playbackMode) return;
    const player = deps.lazyPlayer();
    const dx = player.pos.x - position.x, dy = player.pos.y - position.y, dz = player.pos.z - position.z;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (err < 0.5) {
      logger.info(`Correction ignored: ${err.toFixed(2)}m below snap threshold`);
      return;
    }
    const journal = inputSeq !== undefined ? nm().inputsAfter(inputSeq) : [];
    if (journal.length === 0) {
      player.pos.set(position.x, position.y, position.z);
      player.vel.set(velocity.x, velocity.y, velocity.z);
      // NEVER touch yaw/pitch — the server echoes our last *accepted*
      // rotation, which can be seconds stale. Aim is client-authoritative;
      // snapping it warps the camera 40-60° for no gameplay reason.
      void rotation;
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
    for (let i = 0; i < journal.length; i++) {
      const e = journal[i];
      const nextT = i + 1 < journal.length ? journal[i + 1].t : now;
      player.movement.setInput({
        forward: e.input.forward, right: e.input.right,
        jumpPressed: !!e.input.jump, jumpHeld: !!e.input.jump,
        skiHeld: !!e.input.ski, jetHeld: !!e.input.jet,
      });
      player.movement.update(Math.min(0.25, Math.max(0, (nextT - e.t) / 1000)));
    }
    const st = player.movement.getState();
    player.pos.set(st.pos.x, st.pos.y, st.pos.z);
    player.vel.set(st.vel.x, st.vel.y, st.vel.z);
    player.onGround = st.onGround;
    player.syncMovement();
    logger.info(`Correction replayed: ${err.toFixed(2)}m err, ${journal.length} inputs from seq ${inputSeq}`);
  };

  // Declared remote teleport (another player's warp): snap the visual —
  // interpolating across a 50m gap reads as a rocket-flight glitch
  networkManager.onRemoteTeleport = (playerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => {
    const rp = deps.world.remotePlayers.get(playerId);
    if (!rp) return;
    rp.teleportTo(new THREE.Vector3(position.x, position.y, position.z));
    void velocity; // next tick record carries it — no need to touch internals
  };

  networkManager.onPlayerKill = (shooterId, targetId, weapon) => onPlayerKill(ctx, streak, shooterId, targetId, weapon);
}

/** A kill landed somewhere: feed row for everyone, death overlay when it's
 *  you, frag headline + streak when it's yours, ragdoll for the victim. */
function onPlayerKill(ctx: NetCtx, streak: { v: number }, shooterId: string, targetId: string, weapon?: number): void {
  const { deps, nm } = ctx;
  const logger = deps.logger;
  if (deps.world.playbackMode) return;
  noteKill(shooterId, targetId, weapon); // Alt+Q battle log
  deps.world.killCounts.set(shooterId, (deps.world.killCounts.get(shooterId) ?? 0) + 1);
  const localId = nm().getLocalPlayerId();
  deps.lazyHud().feedKill(shooterId, targetId, shooterId === localId, targetId === localId, weapon);
  if (targetId === localId) {
    logger.info(`Local player killed by ${shooterId}`);
    const player = deps.lazyPlayer();
    player.isDead = true;
    player.health = 0;
    deps.lazyHud().hide();
    deps.lazyHud().setDeathOverlay(true);
    streak.v = 0;
    deps.fragMessages.show(shooterId === 'environment'
      ? `YOU DIED\n${player.lastDamageSource || 'claimed by the wasteland'}`
      : `YOU DIED\nfragged by ${shooterId}`);
    return;
  }

  // Streak counts run-kills since your last death (reset in the branch above).
  if (shooterId === localId) {
    const streakName = STREAK_NAMES.find(([n]) => ++streak.v >= n)?.[1];
    deps.fragMessages.show(streakName ? `FRAGGED PLAYER!\n${streakName}` : `FRAGGED PLAYER!`);
    sfx.killConfirm();
  }

  // Mark dead immediately so the main loop stops simulating them
  const playerData = nm().getPlayers().get(targetId);
  if (playerData) {
    playerData.isDead = true;
    playerData.health = 0;
  }

  const remotePlayer = deps.world.remotePlayers.get(targetId);
  if (remotePlayer) {
    gibVictim(ctx, shooterId, targetId, remotePlayer);
    logger.info(`Player ${targetId} killed by ${shooterId}`);
  }
}

/** Victim fx: ragdoll with the blast's impulse, capsule-shard gibs in the
 *  team color, then hide the model and strip HUD markers. */
function gibVictim(ctx: NetCtx, shooterId: string, targetId: string, remotePlayer: import('../../entities/RemotePlayer.js').RemotePlayer): void {
  const { deps, nm } = ctx;
  // Find matching explosion from this shooter
  let explosionPos: THREE.Vector3 | undefined;
  let explosionForce: number | undefined;
  for (const exp of deps.explosionTracker.getRecentExplosions()) {
    if (exp.shooterId === shooterId) {
      explosionPos = exp.position;
      explosionForce = exp.force;
      break;
    }
  }

  // Play death animation (ragdoll physics with explosion impulse)
  remotePlayer.playDeath(explosionPos, explosionForce);

  // Shatter like the creatures do: shards burst off the capsule shell,
  // carry the blast direction through the body, and inherit whatever
  // speed the corpse had. Team color when known, robot grey otherwise.
  const centerY = remotePlayer.position.y - 0.6; // eye ~1.6 → chest
  let impulseDir: THREE.Vector3 | undefined;
  if (explosionPos) {
    impulseDir = new THREE.Vector3(
      remotePlayer.position.x - explosionPos.x,
      centerY - explosionPos.y,
      remotePlayer.position.z - explosionPos.z,
    );
    const l = impulseDir.length() || 1;
    impulseDir.multiplyScalar(Math.min(1.5, (explosionForce ?? 10) / 15) / l);
  }
  const team = nm().getPlayers().get(targetId)?.team
    ?? (remotePlayer as { team?: 'alpha' | 'bravo' }).team;
  // Gibs are best-effort — a degenerate model must never take the kill
  // handler down with it (generic chunks still spawn on null).
  let parts: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | undefined;
  try { parts = remotePlayer.model.deathParts() ?? undefined; }
  catch { /* fall through to generic shards */ }
  deps.world.playerDebrisList.push(new PlayerDebris(
    deps.lazyScene(), deps.lazyTerrain(),
    { x: remotePlayer.position.x, y: centerY, z: remotePlayer.position.z },
    new THREE.Color(team ? TEAM_COLORS[team] : 0x8899aa),
    { impulseDir, inheritVel: remotePlayer.vel, parts },
  ));

  remotePlayer.hide();
  deps.lazyHud().removePlayerIndicator(targetId);
  deps.lazyHealthBarSystem().removeBar(targetId);
}

/** Updates, respawns, join/leave, movement events — the presence wire. */
function wirePlayerLifecycle(ctx: NetCtx): void {
  const { deps, networkManager, nm, ensureRemotePlayer } = ctx;
  const logger = deps.logger;

  networkManager.onPlayerJump = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJumpDust(pos);
  };

  networkManager.onPlayerJetpack = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJetpack(pos);
  };

  networkManager.onPlayerUpdate = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, _timestamp: number, velocity?: { x: number; y: number; z: number }) => {
    // Safety: never process local player as a remote player
    if (playerId === nm().getLocalPlayerId()) return;
    let remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.update(position, rotation, REMOTE_PLAYER_FIXED_DT, nm().getPing(), velocity);
      if (Math.random() < DEBUG_LOG_SAMPLE_RATE) { // 5% of updates log for debugging
        logger.debug(`onPlayerUpdate: ${playerId} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`);
      }
      return;
    }

    // Don't create RemotePlayer for dead players — wait for respawn event
    const playerData = nm().getPlayers().get(playerId);
    if (playerData?.isDead) return;
    logger.debug(`onPlayerUpdate called for unknown player: ${playerId}, creating...`);
    ensureRemotePlayer(playerId, position, 'onPlayerUpdate');
  };

  networkManager.onPlayerRespawn = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, armorClass?: string) => {
    if (deps.world.playbackMode) return;
    // Check if local player respawned
    if (playerId === nm().getLocalPlayerId()) {
      logger.info(`Local player respawned at ${JSON.stringify(position)}`);
      const player = deps.lazyPlayer();
      // The respawn carries the class the server actually banked — trust
      // it over the local pick or a dropped classUpdate leaves the client
      // shouldering ordnance the authority still calls class-locked.
      if (armorClass) player.armorClass = armorClass as ArmorClass;
      player.resetLifeState();
      player.pos.set(position.x, position.y, position.z);
      deps.setLastSentPos({ x: position.x, y: position.y, z: position.z });
      player.yaw = rotation.yaw;
      player.pitch = rotation.pitch;
      player.syncMovement(); // reseat controller or its snapshot overwrites the respawn
      player.markTeleport(); // spawn point can sit >50m from the corpse
      deps.lazyHud().show();
      deps.lazyHud().setDeathOverlay(false);
      return;
    }

    // Reset existing remote player on respawn
    const remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      const playerData = nm().getPlayers().get(playerId);
      const internalId = playerData?.internalId || 'unknown';
      if (armorClass) remotePlayer.setClass(armorClass); // respawn may carry a banked tier swap
      remotePlayer.respawn(position);
      logger.info(`Player ${playerId} (internalId: ${internalId}) respawned at ${JSON.stringify(position)}`);
    } else {
      // Create new remote player if they don't exist (shouldn't happen but safety check)
      ensureRemotePlayer(playerId, position, 'onPlayerRespawn');
    }
  };

  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, _rotation: { yaw: number; pitch: number }) => {
    if (deps.world.playbackMode) return;
    // Safety: server excludes self from playerJoined broadcast, but guard anyway
    if (playerId === nm().getLocalPlayerId()) return;
    const playerData = nm().getPlayers().get(playerId);
    const internalId = playerData?.internalId || 'unknown';
    const terrainHeight = deps.lazyTerrain().getHeight(position.x, position.z);
    const aboveTerrain = position.y >= terrainHeight;
    logger.info(`Player joined: ${playerId} (internalId: ${internalId}) at ${JSON.stringify(position)} | Terrain height: ${terrainHeight.toFixed(1)} | ${aboveTerrain ? '✓ Above/at terrain' : '✗ BELOW TERRAIN'}`);
    // RemotePlayer will be created in the main loop when networkManager.getPlayers() includes this player
  };

  networkManager.onPlayerLeft = (playerId: string) => {
    if (deps.world.remotePlayers.remove(playerId)) {
      logger.info(`Remote player removed (playerLeft): ${playerId}`);
    }
  };
}
