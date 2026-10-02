/**
 * net/playerKill — the kill wire: feed rows, death overlay, frag
 * headlines + streaks, and the victim gib (ragdoll impulse + team-color
 * capsule shards + HUD marker strip). players.ts keeps hit/knockback/
 * correction/lifecycle handlers.
 */
import * as THREE from 'three';
import * as sfx from '../../core/sfx.js';
import { PlayerDebris } from '../../effects/debris.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';
import { noteKill } from '../../core/stateDebug.js';
import type { RemotePlayer } from '../../entities/RemotePlayer.js';
import type { NetCtx } from './ctx.js';

/** Tribes streak titles by kills-since-death — subtitle under the frag
 *  headline at 3/5/7/10. */
const STREAK_NAMES: [number, string][] = [
  [10, 'GODLIKE'], [7, 'UNSTOPPABLE'], [5, 'RAMPAGE'], [3, 'KILLING SPREE'],
];

/** A kill landed somewhere: feed row for everyone, death overlay when it's
 *  you, frag headline + streak when it's yours, ragdoll for the victim. */
export function onPlayerKill(ctx: NetCtx, streak: { v: number }, shooterId: string, targetId: string, weapon?: number): void {
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
      : shooterId === targetId
        ? `YOU DIED\nfragged yourself`
        : `YOU DIED\nfragged by ${shooterId}`);
    return;
  }

  // Streak counts run-kills since your last death (reset in the branch above).
  if (shooterId === localId) {
    const streakName = STREAK_NAMES.find(([n]) => ++streak.v >= n)?.[1];
    const name = targetId.replace(/^bot:/, '');
    deps.fragMessages.showKill(streakName ? `FRAGGED ${name}!\n${streakName}` : `FRAGGED ${name}!`);
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
function gibVictim(ctx: NetCtx, shooterId: string, targetId: string, remotePlayer: RemotePlayer): void {
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
    ?? (remotePlayer as { team?: TeamId }).team;
  // Gibs are best-effort — a degenerate model must never take the kill
  // handler down with it (generic chunks still spawn on null). Past
  // ~120m real body parts are indistinguishable from primitive shards,
  // so far kills take the instanced path — mesh-path gibs are ~20
  // unique materials and matrix writes each (~7ms spikes under throttle).
  const cam = deps.lazyPlayer().pos;
  const gdx = remotePlayer.position.x - cam.x, gdy = centerY - cam.y, gdz = remotePlayer.position.z - cam.z;
  const nearEnough = gdx * gdx + gdy * gdy + gdz * gdz < 120 * 120;
  let parts: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | undefined;
  if (nearEnough) {
    try { parts = remotePlayer.model.deathParts() ?? undefined; }
    catch { /* fall through to generic shards */ }
  }
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
