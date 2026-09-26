import * as THREE from 'three';

import type { ChildLogger } from '../core/Logger.js';
import type { Terrain } from '../world/terrain.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { EffectsManager } from '../effects/effects.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { HUD } from '../ui/hud.js';

export interface RemotesDeps {
  networkManager: () => NetworkManager;
  scene: () => THREE.Scene;
  terrain: () => Terrain;
  camera: () => THREE.PerspectiveCamera;
  player: () => Player;
  hud: () => HUD;
  healthBarSystem: () => HealthBarSystem;
  effects: () => EffectsManager;
  logger: ChildLogger;
  remotePlayers: Map<string, RemotePlayer>;
  playersBeingCreated: Set<string>;
  killCounts: Map<string, number>;
}

// Remote player + scoreboard per-frame work: position send, remote ticks,
// stale-player pruning, HUD indicators, scoreboard rows.
export function createRemotes(deps: RemotesDeps) {
  let lastSentPos = { x: 0, y: 0, z: 0 };
  let lastRemotePosLog = '';

  function getLastSentPos() { return lastSentPos; }
  function setLastSentPos(pos: { x: number; y: number; z: number }) {
    lastSentPos.x = pos.x; lastSentPos.y = pos.y; lastSentPos.z = pos.z;
  }

  // Network per-frame work: send position, tick remote players, prune stale ones
  function networkTick(dt: number): void {
    const nm = deps.networkManager();
    const player = deps.player();
    lastSentPos.x = player.pos.x;
    lastSentPos.y = player.pos.y;
    lastSentPos.z = player.pos.z;
    nm.sendPosition(
      { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      { yaw: player.yaw, pitch: player.pitch },
      { x: player.vel.x, y: player.vel.y, z: player.vel.z }
    );

    const players = nm.getPlayers();
    const previousRemoteCount = deps.remotePlayers.size;

    // Update player list UI — local player first; drop stale remotes (no updates in 60s)
    const localPlayerId = nm.getLocalPlayerId();
    const activeIds = Array.from(players.keys()).filter(id => {
      if (id === localPlayerId) return false;
      const rp = deps.remotePlayers.get(id);
      const ps = players.get(id);
      if (ps?.ping == null) return false; // never proven connected
      if (!rp) return true;
      return Date.now() - rp.lastUpdateTime <= 60000;
    });
    deps.hud().updatePlayerList([localPlayerId, ...activeIds], localPlayerId);

    // Roster-change log — joins/leaves only; positions live in stateDebug
    // (?debug). Per-position logging at 60Hz was a console flood.
    const rosterKey = [...players.keys()].filter(id => id !== localPlayerId).sort().join(',');
    if (rosterKey !== lastRemotePosLog) {
      lastRemotePosLog = rosterKey;
      deps.logger.info(`Remote roster: ${rosterKey || 'none'}`);
    }

    players.forEach((playerState, playerId) => tickRemotePlayer(playerId, playerState, dt));
    cleanupRemotePlayers(players);

    if (deps.remotePlayers.size !== previousRemoteCount) {
      deps.logger.debug(`Remote players in scene: ${deps.remotePlayers.size} | Scene children: ${deps.scene().children.length}`);
    }
  }

  // Per-remote-player frame work: create if new, hide if stale, tick, ski dust, HUD
  function tickRemotePlayer(playerId: string, playerState: import('../networking/NetworkManager.js').RemotePlayerState, dt: number): void {
    const nm = deps.networkManager();
    const terrain = deps.terrain();
    const hud = deps.hud();
    if (playerId === nm.getLocalPlayerId()) return;

    let remotePlayer = deps.remotePlayers.get(playerId);
    if (!remotePlayer && !deps.playersBeingCreated.has(playerId) && !playerState.isDead) {
      deps.playersBeingCreated.add(playerId);
      remotePlayer = new RemotePlayer(deps.scene(), playerId, playerState.position, terrain);
      deps.remotePlayers.set(playerId, remotePlayer);
      deps.playersBeingCreated.delete(playerId);
      deps.logger.debug(`CREATED remote player`, { instanceId: remotePlayer.instanceId, playerId, total: deps.remotePlayers.size });
    }
    if (!remotePlayer) return; // Skip if being created by onPlayerUpdate or failed

    // Hide stale remote players — backgrounded tabs keep the socket open but
    // stop sending updates, leaving ghosts standing around. 60s grace covers
    // genuine packet loss; dead reckoning handles shorter gaps. Players that
    // never reported ping (>5s without one) are dead sockets — hide them too.
    const age = Date.now() - remotePlayer.lastUpdateTime;
    const inactive = age > 60000 || nm.getPlayers().get(playerId)?.ping == null;
    remotePlayer.setStaleHidden(inactive);
    if (inactive) {
      hud.removePlayerIndicator(playerId);
      deps.healthBarSystem().removeBar(playerId);
      return;
    }

    // RemotePlayer.update is called via onPlayerUpdate callback to store target position
    // Call tick() every frame for smooth interpolation (includes dead reckoning trigger).
    // tick() already calls this.model.update(dt) internally — do NOT call it again here,
    // or animations advance at 2x speed (double AnimationMixer.update).
    remotePlayer.tick(dt);

    // Ski dust: networked ski flag (via tickUpdate) + near-ground + moving
    if (!playerState.isDead && playerState.ski) {
      const v = remotePlayer.vel;
      const horizSq = v.x * v.x + v.z * v.z;
      const feetY = remotePlayer.feetY;
      const groundY = terrain.getHeight(remotePlayer.position.x, remotePlayer.position.z);
      if (horizSq > 10 && feetY - groundY < 0.8) {
        deps.effects().spawnSkiDust(remotePlayer.position, v);
      }
    }

    // Update HUD indicator for this player (skip if dead)
    // Use RemotePlayer's extrapolated position for LAN-feel responsiveness
    if (!playerState.isDead) {
      hud.updatePlayerIndicator(playerId, remotePlayer.position, deps.camera(), false);
    } else {
      hud.removePlayerIndicator(playerId);
    }
  }

  // Remove disconnected players and dead players that have shrunk to 0
  function cleanupRemotePlayers(players: Map<string, import('../networking/NetworkManager.js').RemotePlayerState>): void {
    const hud = deps.hud();
    for (const [playerId, remotePlayer] of deps.remotePlayers) {
      const gone = !players.has(playerId);
      const shrunkAway = remotePlayer.scale === 0;
      if (!gone && !shrunkAway) continue;
      deps.logger.debug(`REMOVED remote player`, { reason: gone ? 'player left' : 'scale=0', instanceId: remotePlayer.instanceId, playerId });
      remotePlayer.dispose();
      deps.remotePlayers.delete(playerId);
      hud.removePlayerIndicator(playerId);
      deps.healthBarSystem().removeBar(playerId);
    }
  }

  // Scoreboard rows: local player first, then remotes sorted by frags desc
  function updateScoreboard(): void {
    const hud = deps.hud();
    if (!hud.scoreboardVisible) return;
    const nm = deps.networkManager();
    const localId = nm.getLocalPlayerId();
    const rows = [{ name: localId, frags: deps.killCounts.get(localId) ?? 0, ping: nm.getPing(), self: true, dead: deps.player().isDead }];
    const remoteRows = [...nm.getPlayers().keys()]
      .filter(id => {
        if (id === localId) return false;
        const rp = deps.remotePlayers.get(id);
        const ps = nm.getPlayers().get(id);
        if (ps?.ping == null) return false; // never proven connected
        if (!rp) return true;
        return Date.now() - rp.lastUpdateTime <= 60000; // hide stale
      })
      .map(id => {
        const ps = nm.getPlayers().get(id);
        return { name: id, frags: deps.killCounts.get(id) ?? 0, ping: ps?.ping ?? null, self: false, dead: ps?.isDead ?? false };
      });
    remoteRows.sort((a, b) => b.frags - a.frags);
    hud.setScoreboardRows([...rows, ...remoteRows]);
  }

  return { networkTick, updateScoreboard, getLastSentPos, setLastSentPos };
}
