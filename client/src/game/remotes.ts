import * as THREE from 'three';

import type { ChildLogger } from '../core/Logger.js';
import type { Terrain } from '../world/terrain.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { EffectsManager } from '../effects/effects.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { HUD } from '../ui/hud.js';
import type { WorldState } from './worldState.js';
import { TEAM_COLORS } from '../../../shared/teams.js';

// Hostiles always read red — team colors are for your own side only.
const ENEMY_RED = 0xff3333;

export interface RemotesDeps {
  lazyNetworkManager: () => NetworkManager;
  lazyScene: () => THREE.Scene;
  lazyTerrain: () => Terrain;
  lazyCamera: () => THREE.PerspectiveCamera;
  lazyPlayer: () => Player;
  lazyHud: () => HUD;
  lazyHealthBarSystem: () => HealthBarSystem;
  lazyEffects: () => EffectsManager;
  logger: ChildLogger;
  world: WorldState;
}

// Remote player + scoreboard per-frame work: position send, remote ticks,
// stale-player pruning, HUD indicators, scoreboard rows.
export function createRemotes(deps: RemotesDeps) {
  let lastSentPos = { x: 0, y: 0, z: 0 };
  let lastRemotePosLog = '';
  const lastTintOf = new Map<string, string>();
  let rosterPollT = 0;

  function getLastSentPos() { return lastSentPos; }
  function setLastSentPos(pos: { x: number; y: number; z: number }) {
    lastSentPos.x = pos.x; lastSentPos.y = pos.y; lastSentPos.z = pos.z;
  }

  // Remote is worth showing: proven connected (has ping) and either not yet
  // instantiated or heard from within the 60s stale window
  function isRemoteActive(playerId: string, players: Map<string, import('../networking/NetworkManager.js').RemotePlayerState>): boolean {
    const rp = deps.world.remotePlayers.get(playerId);
    const ps = players.get(playerId);
    if (ps?.ping == null) return false;
    if (!rp) return true;
    return Date.now() - rp.lastUpdateTime <= 60000;
  }

  // Network per-frame work: send position, tick remote players, prune stale ones
  function networkTick(dt: number): void {
    const nm = deps.lazyNetworkManager();
    const player = deps.lazyPlayer();
    // Demo playback drives player.pos from recorded frames — sending them
    // would look like teleport spam to the server, and live remote ticks
    // would mix the real match into the replay scene.
    if (deps.world.playbackMode) {
      player.pendingTeleport = false; // don't queue a stale teleport for later
      return;
    }
    lastSentPos.x = player.pos.x;
    lastSentPos.y = player.pos.y;
    lastSentPos.z = player.pos.z;
    // Declared teleport (warp/respawn): precede the position stream so
    // the server anchors its plausibility check at the NEW spot
    if (player.pendingTeleport) {
      player.pendingTeleport = false;
      nm.sendTeleport(
        { x: player.pos.x, y: player.pos.y, z: player.pos.z },
        { yaw: player.yaw, pitch: player.pitch },
        { x: player.vel.x, y: player.vel.y, z: player.vel.z },
      );
    }
    nm.sendPosition(
      { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      { yaw: player.yaw, pitch: player.pitch },
      { x: player.vel.x, y: player.vel.y, z: player.vel.z }
    );

    const players = nm.getPlayers();
    const previousRemoteCount = deps.world.remotePlayers.size;

    // Update player list UI — local player first; drop stale remotes (no updates in 60s)
    const localPlayerId = nm.getLocalPlayerId();
    const activeIds = Array.from(players.keys()).filter(id => id !== localPlayerId && isRemoteActive(id, players));
    deps.lazyHud().updatePlayerList([localPlayerId, ...activeIds], localPlayerId);

    // Roster-change log — joins/leaves only; positions live in stateDebug
    // (?debug). Per-position logging at 60Hz was a console flood. Polled at
    // 2Hz — a join/leave logged half a second late loses nothing.
    rosterPollT -= dt;
    if (rosterPollT <= 0) {
      rosterPollT = 0.5;
      const rosterKey = [...players.keys()].filter(id => id !== localPlayerId).sort().join(',');
      if (rosterKey !== lastRemotePosLog) {
        lastRemotePosLog = rosterKey;
        deps.logger.info(`Remote roster: ${rosterKey || 'none'}`);
      }
    }

    players.forEach((playerState, playerId) => tickRemotePlayer(playerId, playerState, dt));
    cleanupRemotePlayers(players);

    if (deps.world.remotePlayers.size !== previousRemoteCount) {
      deps.logger.debug(`Remote players in scene: ${deps.world.remotePlayers.size} | Scene children: ${deps.lazyScene().children.length}`);
    }
  }

  // Per-remote-player frame work: create if new, hide if stale, tick, ski dust, HUD
  function tickRemotePlayer(playerId: string, playerState: import('../networking/NetworkManager.js').RemotePlayerState, dt: number): void {
    const nm = deps.lazyNetworkManager();
    const terrain = deps.lazyTerrain();
    const hud = deps.lazyHud();
    if (playerId === nm.getLocalPlayerId()) return;

    let remotePlayer = deps.world.remotePlayers.get(playerId);
    if (!remotePlayer && !playerState.isDead) {
      remotePlayer = new RemotePlayer(deps.lazyScene(), playerId, playerState.position, terrain);
      deps.world.remotePlayers.set(playerId, remotePlayer);
      deps.logger.debug(`CREATED remote player`, { instanceId: remotePlayer.instanceId, playerId, total: deps.world.remotePlayers.size });
    }
    if (!remotePlayer) return;

    // Hide stale remote players — backgrounded tabs keep the socket open but
    // stop sending updates, leaving ghosts standing around. 60s grace covers
    // genuine packet loss; dead reckoning handles shorter gaps. Players that
    // never reported ping (>5s without one) are dead sockets — hide them too.
    const age = Date.now() - remotePlayer.lastUpdateTime;
    const inactive = age > 60000 || nm.getPlayers().get(playerId)?.ping == null;
    remotePlayer.setStaleHidden(inactive);
    if (inactive) {
      hud.removePlayerIndicator(playerId);
      deps.lazyHealthBarSystem().removeBar(playerId);
      return;
    }

    // RemotePlayer.update is called via onPlayerUpdate callback to store target position
    // Call tick() every frame for smooth interpolation (includes dead reckoning trigger).
    // tick() already calls this.model.update(dt) internally — do NOT call it again here,
    // or animations advance at 2x speed (double AnimationMixer.update).
    remotePlayer.tick(dt);

    // Wire cloak: hide model+gizmo+marker entirely — an enemy's HUD must
    // give no trace. Ski dust and indicators stop too (dust off an
    // invisible skier is a giveaway).
    remotePlayer.setCloakHidden(!!playerState.cloaked);
    remotePlayer.setShielded(!!playerState.shielded);
    if (playerState.cloaked) {
      hud.removePlayerIndicator(playerId);
      deps.lazyHealthBarSystem().removeBar(playerId);
      return;
    }

    // Friend-or-foe marker: teammates wear their team's color, enemies are
    // always red — matching a remote's wire team only when it differs from
    // the last applied tint avoids re-setting every frame.
    const theirTeam = playerState.team;
    if (theirTeam && theirTeam !== lastTintOf.get(playerId)) {
      lastTintOf.set(playerId, theirTeam);
      remotePlayer.setGizmoColor(theirTeam === deps.world.localTeam ? TEAM_COLORS[theirTeam] : ENEMY_RED);
    }

    // Ski dust: networked ski flag (via tickUpdate) + near-ground + moving
    if (!playerState.isDead && playerState.ski) {
      const v = remotePlayer.vel;
      const horizSq = v.x * v.x + v.z * v.z;
      const feetY = remotePlayer.feetY;
      const groundY = terrain.getHeight(remotePlayer.position.x, remotePlayer.position.z);
      if (horizSq > 10 && feetY - groundY < 0.8) {
        deps.lazyEffects().spawnSkiDust(remotePlayer.position, v);
      }
    }

    // Update HUD indicator for this player (skip if dead)
    // Use RemotePlayer's extrapolated position for LAN-feel responsiveness
    if (!playerState.isDead) {
      hud.updatePlayerIndicator(playerId, remotePlayer.position, deps.lazyCamera(), false);
    } else {
      hud.removePlayerIndicator(playerId);
    }
  }

  // Remove disconnected players and dead players that have shrunk to 0
  function cleanupRemotePlayers(players: Map<string, import('../networking/NetworkManager.js').RemotePlayerState>): void {
    const hud = deps.lazyHud();
    for (const [playerId, remotePlayer] of deps.world.remotePlayers) {
      // `bot:` entries are locally driven (Nugget Wars) — the network
      // roster knows nothing about them; cleanup is owned by TeamBots.
      if (playerId.startsWith('bot:')) continue;
      const gone = !players.has(playerId);
      const shrunkAway = remotePlayer.scale === 0;
      if (!gone && !shrunkAway) continue;
      deps.logger.debug(`REMOVED remote player`, { reason: gone ? 'player left' : 'scale=0', instanceId: remotePlayer.instanceId, playerId });
      remotePlayer.dispose();
      deps.world.remotePlayers.delete(playerId);
      hud.removePlayerIndicator(playerId);
      deps.lazyHealthBarSystem().removeBar(playerId);
    }
  }

  // Scoreboard rows: local player first, then remotes sorted by frags desc
  function updateScoreboard(): void {
    const hud = deps.lazyHud();
    if (!hud.scoreboardVisible) return;
    const nm = deps.lazyNetworkManager();
    const localId = nm.getLocalPlayerId();
    const ffa = deps.world.ffaScores;
    const rows = [{ name: localId, frags: deps.world.killCounts.get(localId) ?? 0, score: ffa.get(localId) ?? null, ping: nm.getPing(), self: true, dead: deps.lazyPlayer().isDead, team: deps.world.localTeam }];
    const remoteRows = [...nm.getPlayers().keys()]
      .filter(id => id !== localId && isRemoteActive(id, nm.getPlayers()))
      .map(id => {
        const ps = nm.getPlayers().get(id);
        return { name: id, frags: deps.world.killCounts.get(id) ?? 0, score: ffa.get(id) ?? null, ping: ps?.ping ?? null, self: false, dead: ps?.isDead ?? false, team: ps?.team };
      });
    // Offline bots live in world.remotePlayers, not the network roster —
    // they'd be invisible on the scoreboard otherwise.
    for (const [id, rp] of deps.world.remotePlayers) {
      if (nm.getPlayers().has(id)) continue;
      remoteRows.push({ name: id.replace('bot:', ''), frags: deps.world.killCounts.get(id) ?? 0, score: deps.world.ffaScores.get(id) ?? null, ping: null, self: false, dead: rp.isDead, team: undefined });
    }
    remoteRows.sort((a, b) => (b.score ?? b.frags) - (a.score ?? a.frags));
    hud.setScoreboardRows([...rows, ...remoteRows]);
  }

  return { networkTick, updateScoreboard, getLastSentPos, setLastSentPos };
}
