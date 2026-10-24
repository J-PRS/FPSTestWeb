/**
 * net/playerKill — the kill wire: feed rows, death overlay, frag
 * headlines + streaks, and the victim gib (ragdoll impulse + team-color
 * capsule shards + HUD marker strip). players.ts keeps hit/knockback/
 * correction/lifecycle handlers.
 */
import * as THREE from 'three';
import * as sfx from '../../core/sfx.js';
import { speakAnnounce } from '../../core/tts.js';
import { PlayerDebris } from '../../effects/debris.js';
import { lifestealBurst } from '../../effects/vfx.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';
import { displayName } from '../nameOf.js';
import { noteKill } from '../../core/stateDebug.js';
import { noteCorpseFling } from './pickups.js';
import type { RemotePlayer } from '../../entities/RemotePlayer.js';
import type { NetCtx } from './ctx.js';

/** UT-style streak ladder — one title per 5 kills since your last death.
 *  Ordered high→low; matched with `===` so each announces once. */
const STREAK_NAMES: [number, string][] = [
  [30, 'WICKED SICK'], [25, 'GODLIKE'], [20, 'UNSTOPPABLE'], [15, 'DOMINATING'],
  [10, 'RAMPAGE'], [5, 'KILLING SPREE'],
];

/** Full-gib budget: the mesh path (bakeDeathParts) is ~20 unique geos +
 *  matrix writes — one kill costs ~7ms on a hot frame, and a dogpile of
 *  chained kills stacks them into a visible hitch. Space the heavy path
 *  to one per 250ms; kills inside the window fall back to the ragdoll
 *  (which still plays regardless) + a light shard puff. */
let lastFullGibAt = 0;
const FULL_GIB_GAP_MS = 250;

/** Victim fx: ragdoll with the blast's impulse, capsule-shard gibs in the
 *  team color, then hide the model and strip HUD markers. */
function gibVictim(ctx: NetCtx, shooterId: string, targetId: string, remotePlayer: RemotePlayer): void {
  const { deps, nm } = ctx;
  // Find matching explosion from this shooter
  let explosionPos: THREE.Vector3 | undefined = undefined;
  let explosionForce: number | undefined = undefined;
  for (const exp of deps.explosionTracker.getRecentExplosions()) {
    if (exp.shooterId === shooterId) {
      explosionPos = exp.position;
      explosionForce = exp.force;
      break;
    }
  }

  // Play death animation (ragdoll physics with explosion impulse)
  remotePlayer.playDeath(explosionPos, explosionForce);
  // Loot scatters at wire truth but this corpse fell at the RENDERED
  // pos — pickups.ts flings its nuggets from here to the server rest
  // spots so the drop reads as bursting out of the body you saw die.
  noteCorpseFling(remotePlayer.position);

  // Shatter like the creatures do: shards burst off the capsule shell,
  // carry the blast direction through the body, and inherit whatever
  // speed the corpse had. Team color when known, robot grey otherwise.
  const centerY = remotePlayer.position.y - 0.6; // eye ~1.6 → chest
  let impulseDir: THREE.Vector3 | undefined = undefined;
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
  const now = performance.now();
  const fullGib = now - lastFullGibAt >= FULL_GIB_GAP_MS;
  if (fullGib) {lastFullGibAt = now;}
  let parts: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | undefined = undefined;
  if (nearEnough && fullGib) {
    try { parts = remotePlayer.model.deathParts() ?? undefined; }
    catch { /* fall through to generic shards */ }
  }
  deps.world.playerDebrisList.push(new PlayerDebris(
    deps.lazyScene(), deps.lazyTerrain(),
    { x: remotePlayer.position.x, y: centerY, z: remotePlayer.position.z },
    new THREE.Color(team ? TEAM_COLORS[team] : 0x88_99_AA),
    { impulseDir, inheritVel: remotePlayer.vel, parts, shardGeos: parts?.map((p) => p.geo), count: fullGib ? undefined : 6, smoke: fullGib },
  ));

  remotePlayer.hide();
  deps.lazyHud().removePlayerIndicator(targetId);
  deps.lazyHealthBarSystem().removeBar(targetId);
}



const _stealPos = new THREE.Vector3();

/** Victim is us: flag dead, HUD down, overlay up, pick the epitaph. */
function ownDeath(ctx: NetCtx, shooterId: string, targetId: string, roster: Map<string, { name?: string }>): void {
  const { deps } = ctx;
  deps.logger.info(`Local player killed by ${shooterId}`);
  const player = deps.lazyPlayer();
  player.isDead = true;
  player.health = 0;
  deps.lazyHud().hide();
  deps.lazyHud().setDeathOverlay(true);
  deps.world.killStreak = 0;
  const deathMsg = shooterId === 'environment' ? `YOU DIED\n${player.lastDamageSource || 'claimed by the wasteland'}`
    : shooterId === targetId ? 'YOU DIED\nfragged yourself'
      : `YOU DIED\nfragged by ${displayName(shooterId, roster)}`;
  deps.fragMessages.show(deathMsg);
  // Kill-cam: follow the killer's replica for ~4s — informational
  // closure, not intel (you're dead; they know you're dead). A spectate
  // press or the timeout drops to the normal teammate cycle / ghost.
  if (shooterId !== 'environment' && shooterId !== targetId) {
    const killer = deps.world.remotePlayers.get(shooterId);
    if (killer && !killer.isDead) {
      player.spectateAnchor = killer;
      player.spectateAnchorUntil = performance.now() + 4000;
      player.spectateAnchorFrom.copy(player.pos);
      player.spectateAnchorStart = performance.now();
    }
  }
}

export function onPlayerKill(ctx: NetCtx, shooterId: string, targetId: string, weapon?: number, air?: number, steal?: boolean): void {
  const { deps, nm } = ctx;
  const {logger} = deps;
  if (deps.world.playbackMode) {return;}
  noteKill(shooterId, targetId, weapon); // Alt+Q battle log
  deps.world.killCounts.set(shooterId, (deps.world.killCounts.get(shooterId) ?? 0) + 1);
  deps.world.deathCounts.set(targetId, (deps.world.deathCounts.get(targetId) ?? 0) + 1);
  const localId = nm().getLocalPlayerId();
  // Demo kill marker — victim pos from the replica (or local body when
  // the victim is us). Recorded before the early-return branches.
  const victimPos = deps.world.remotePlayers.get(targetId)?.position
    ?? (targetId === localId ? deps.lazyPlayer().pos : null);
  if (victimPos) {
    deps.lazyDemoManager?.()?.recordKill(shooterId === 'environment' ? null : shooterId, targetId, weapon ?? 0, victimPos);
  }
  const roster = nm().getPlayers();
  deps.lazyHud().feedKill(shooterId, targetId, shooterId === localId, targetId === localId,
    { shooter: roster.get(shooterId)?.team, target: roster.get(targetId)?.team, weapon, air,
      sName: displayName(shooterId, roster), tName: displayName(targetId, roster) });
  if (targetId === localId) {ownDeath(ctx, shooterId, targetId, roster); return;}

  // Streak counts run-kills since your last death (reset above) and
  // match boundaries (match.ts) — a new match never continues the count.
  if (shooterId === localId) {
    // Announce only on the crossing kill — `>=` repeated the title on
    // every frag past the threshold, so a 4-kill life yelled SPREE twice.
    const streakName = STREAK_NAMES.find(([n]): boolean => (deps.world.killStreak += 1) === n)?.[1];
    const name = displayName(targetId, roster);
    deps.fragMessages.showKill(streakName ? `FRAGGED ${name}!\n${streakName}` : `FRAGGED ${name}!`);
    sfx.killConfirm();
    // The rainbow lob — a frag that rode real airtime earns the booth's
    // 'precision kill' (threshold above the casual-hop band).
    if ((air ?? 0) >= 1.5) {speakAnnounce('PRECISION KILL', 'announce_precision');}
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

  // Lifesteal edge — server flags `steal` only when the heal actually
  // paid; the red implode lands on the KILLER (own face in first person,
  // chest on a remote body).
  if (steal) {
    const pos = shooterId === localId
      ? deps.lazyPlayer().pos
      : deps.world.remotePlayers.get(shooterId)?.position;
    if (pos) {_stealPos.copy(pos); _stealPos.y -= 0.4; lifestealBurst(_stealPos);}
  }
}
