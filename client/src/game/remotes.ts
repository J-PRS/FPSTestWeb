import * as THREE from 'three';
import { STATUS } from '../../../shared/status.js';

import type { ChildLogger } from '../core/Logger.js';
import type { Terrain } from '../world/terrain.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { setFrustumVis } from '../entities/remoteVis.js';
import type { EffectsManager } from '../effects/effects.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { HUD } from '../ui/hud.js';
import { scoreboardTitle } from '../ui/hud/scoreboard.js';
import type { WorldState } from './worldState.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import { isBotId } from '../../../shared/botNames.js';
import * as sfxWorld from '../core/sfx/world.js';

// Hostiles always read red — team colors are for your own side only.
const ENEMY_RED = 0xff3333;

// Shared scratch for the per-tick offscreen test.
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _flagAnchor = new THREE.Vector3();

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
  /** Offline DM owns its score map in TeamBots; network matches populate
   *  world.ffaScores from authoritative score echoes instead. */
  lazyOfflineFfaScores?: () => Map<string, number> | null;
  /** Local sheep meter — the self row's sheep cell reads the same
   *  client-side meter the crosshair readout shows. */
  lazyPlayerSheep?: () => { shown: number };
}

// Remote player + scoreboard per-frame work: position send, remote ticks,
// stale-player pruning, HUD indicators, scoreboard rows.
function makeRemoteHooks(deps: RemotesDeps) {
  return {
    create: (id: string, state: WirePlayerState) => {
      if (state.isDead) return undefined;
      const rp = new RemotePlayer(deps.lazyScene(), id, state.position, deps.lazyTerrain(), state.armorClass);
      rp.setClass(state.armorClass);
      return rp;
    },
    // Bots are hosted in the room sim — they never ping, so the
    // dead-socket gate can't apply to them or they render as ghosts.
    isLive: (id: string, state: WirePlayerState | undefined) => isBotId(id) || state?.ping != null,
    onCreate: (id: string, rp: RemotePlayer) => deps.logger.debug('CREATED remote player', { instanceId: rp.instanceId, playerId: id, total: deps.world.remotePlayers.size }),
    onRemove: (id: string) => {
      deps.lazyHud().removePlayerIndicator(id);
      deps.lazyHealthBarSystem().removeBar(id);
      sfxWorld.remoteMoveAudioGone(id);
    },
  };
}

type WirePlayerState = import('../networking/NetworkManager.js').RemotePlayerState;

function isRemoteActive(deps: RemotesDeps, playerId: string, players: Map<string, WirePlayerState>): boolean {
  return deps.world.remotePlayers.active(playerId, deps.world.remotePlayers.get(playerId), players.get(playerId));
}

// Status bitmask → per-effect visuals. One bit = one row; the next
// toggle effect lands here, nowhere else in the netcode. Returns false
// when cloaked — an enemy's HUD must give no trace (dust off an
// invisible skier is a giveaway). A teammate's cloak is different: it
// stays on screen wearing the ghost shimmer, so only enemies vanish.
function applyStatusVisuals(deps: RemotesDeps, playerId: string, remotePlayer: RemotePlayer, status: number, theirTeam: string | undefined): boolean {
  const cloaked = !!(status & STATUS.CLOAK);
  const friendly = cloaked && !!theirTeam && theirTeam === deps.world.localTeam;
  remotePlayer.setCloakHidden(cloaked && !friendly);
  remotePlayer.setCloakGhosted(cloaked && friendly);
  remotePlayer.setShielded(!!(status & STATUS.SHIELD));
  remotePlayer.setMending(!!(status & STATUS.MEND));
  remotePlayer.setRegenAura(!!(status & STATUS.REGEN));
  remotePlayer.setDdAura(!!(status & STATUS.DD));
  remotePlayer.setCharged(!!(status & STATUS.CHARGED));
  if (!cloaked || friendly) return true;
  deps.lazyHud().removePlayerIndicator(playerId);
  deps.lazyHealthBarSystem().removeBar(playerId);
  return false;
}

// Ski dust off a networked ski flag near the ground, plus the HUD
// name marker from the extrapolated position.
function tickRemoteCosmetics(deps: RemotesDeps, playerId: string, remotePlayer: RemotePlayer, playerState: WirePlayerState): void {
  const hud = deps.lazyHud();
  // The wire ski bit doubles as the animation claim — tuck when held,
  // run when released, regardless of how much momentum remains.
  remotePlayer.wireSki = !playerState.isDead && !!playerState.ski;
  let skiing = false;
  if (!playerState.isDead && playerState.ski) {
    const v = remotePlayer.vel;
    const terrain = deps.lazyTerrain();
    const groundY = terrain.getHeight(remotePlayer.position.x, remotePlayer.position.z);
    if (v.x * v.x + v.z * v.z > 10 && remotePlayer.feetY - groundY < 0.8) {
      skiing = true;
      deps.lazyEffects().spawnSkiDust(remotePlayer.position, v);
    }
  }
  // Jet has no wire bit — a sustained powered climb (vel.y past jump
  // apex) is the only honest tell, matching the remote animation. Bots
  // that write wireJet (brain's real jet button) override the guess.
  const jetting = isJetting(remotePlayer, playerState.isDead);
  if (jetting) deps.lazyEffects().spawnJetpack(remotePlayer.position);
  sfxWorld.remoteMoveAudio(playerId, remotePlayer.position, remotePlayer.vel.length(), jetting, skiing, remotePlayer.vel);
  if (!playerState.isDead) {
    // Teammates read green, everything else stays enemy red — FFA and
    // teamless modes leave `team` undefined so nothing turns friendly.
    const friendly = !!playerState.team && playerState.team === deps.world.localTeam;
    hud.updatePlayerIndicator(playerId, remotePlayer.position, deps.lazyCamera(), { friendly, sheep: playerState.sheep, bot: isBotId(playerId), cls: remotePlayer.armorClass });
  } else {
    hud.removePlayerIndicator(playerId);
  }
}

// One jetting verdict for audio + trail: wireJet when a driver knows the
// real button, else the powered-climb heuristic.
function isJetting(rp: RemotePlayer, dead: boolean): boolean {
  if (dead) return false;
  return rp.wireJet ?? rp.vel.y > 4.5;
}

/** Offscreen flag for the anim gate — one frustum extraction per frame,
 *  a ~2m sphere test per remote. Mixer ticks for culled bodies were pure
 *  waste (the skin never rasterizes). */
function tickOnScreen(deps: RemotesDeps, cam: THREE.PerspectiveCamera): void {
  _frustum.setFromProjectionMatrix(_projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  for (const rp of deps.world.remotePlayers.values()) {
    _sphere.set(rp.position, 2.2);
    rp.onScreen = _frustum.intersectsSphere(_sphere);
    setFrustumVis(rp, !rp.onScreen);
  }
}

// Per-remote-player frame work: create if new, hide if stale, tick, then cosmetics
function tickRemotePlayer(deps: RemotesDeps, lastTintOf: Map<string, string>,
    playerId: string, playerState: WirePlayerState, dt: number): void {
  const nm = deps.lazyNetworkManager();
  if (playerId === nm.getLocalPlayerId()) return;

  const remotePlayer = deps.world.remotePlayers.ensure(playerId, playerState);
  if (!remotePlayer) return;

  // Hide stale remote players — backgrounded tabs keep the socket open but
  // stop sending updates, leaving ghosts standing around. 60s grace covers
  // genuine packet loss; dead reckoning handles shorter gaps. Players that
  // never reported ping (>5s without one) are dead sockets — hide them too.
  const inactive = !deps.world.remotePlayers.active(playerId, remotePlayer, nm.getPlayers().get(playerId));
  deps.world.remotePlayers.setStale(remotePlayer, inactive);
  if (inactive) {
    deps.lazyHud().removePlayerIndicator(playerId);
    deps.lazyHealthBarSystem().removeBar(playerId);
    sfxWorld.remoteMoveAudioGone(playerId);
    return;
  }

  // tick() drives interpolation + dead reckoning and internally advances
  // the AnimationMixer — a second model.update here would 2x animations.
  remotePlayer.tick(dt, deps.lazyCamera().position);

  if (!applyStatusVisuals(deps, playerId, remotePlayer, playerState.status ?? 0, playerState.team)) return;
  applyTeamTint(deps, lastTintOf, playerId, remotePlayer, playerState.team);
  tickRemoteCosmetics(deps, playerId, remotePlayer, playerState);
}

// Friend-or-foe marker: teammates wear their team's color, enemies are
// always red. Tint applies only when the wire team changes.
function applyTeamTint(deps: RemotesDeps, lastTintOf: Map<string, string>,
    playerId: string, remotePlayer: RemotePlayer, theirTeam: string | undefined): void {
  // Debug hitbox wireframe — friendly green, everyone else red. Runs every
  // tick (setHex is free) so teamless/FFA bodies read enemy-red, not the
  // constructor's default green.
  const friendly = !!theirTeam && theirTeam === deps.world.localTeam;
  remotePlayer.setColliderColor(friendly ? 0x00ff00 : ENEMY_RED);
  if (!theirTeam || theirTeam === lastTintOf.get(playerId)) return;
  lastTintOf.set(playerId, theirTeam);
  remotePlayer.setGizmoColor(theirTeam === deps.world.localTeam ? TEAM_COLORS[theirTeam] : ENEMY_RED);
}

/** CTF flag diamonds — projected every frame like player indicators.
 *  This tick also OWNS the flag mesh position (Group.onBeforeRender
 *  never fires, so a render hook can't do it): carried flags ride the
 *  carrier's body, loose flags ease toward the last wire pos so a
 *  knocked flag glides instead of stepping in 50ms jumps. */
function tickFlagMarkers(deps: RemotesDeps, localPlayerId: string,
    playerPos: THREE.Vector3, hud: HUD, cam: THREE.PerspectiveCamera): void {
  for (const [team, marker] of deps.world.flagMarkers) {
    const c = marker.carrier;
    const m = marker.mesh;
    if (c === localPlayerId) {
      m.position.set(playerPos.x, playerPos.y + 0.4, playerPos.z);
    } else if (c) {
      const rp = deps.world.remotePlayers.get(c);
      if (rp) m.position.set(rp.pos.x, rp.pos.y + 0.4, rp.pos.z); // shoulders, not boots
    } else if (m.position.distanceToSquared(marker.wirePos) > 1e-6) {
      m.position.lerp(marker.wirePos, 0.35);
    }
    hud.updateFlagIndicator(`flag:${team}`,
      _flagAnchor.set(m.position.x, m.position.y + 3.4, m.position.z), cam, team);
  }
}

// Remove disconnected players and dead players that have shrunk to 0
function cleanupRemotePlayers(deps: RemotesDeps, players: Map<string, WirePlayerState>): void {
  // `bot:` entries are locally driven (Nugget Wars) — the network roster
  // knows nothing about them; cleanup is owned by TeamBots.
  // 'dummy' is the ?dummy debug body — gameLoop ticks it from a closure,
  // so pruning it would leave a disposed model animating forever.
  deps.world.remotePlayers.prune(
    (id) => isBotId(id) || id === 'dummy' || players.has(id),
    // Bots/dummies keep their body across death+respawn — the death
    // shrink must NOT reap them or they respawn invisible and off-board.
    (id) => isBotId(id) || id === 'dummy',
  );
}

function scoreboardScores(deps: RemotesDeps, nm: NetworkManager, localId: string): { scores: Map<string, number>; localScoreId: string } {
  if (nm.isConnected()) return { scores: deps.world.ffaScores, localScoreId: localId };
  const offline = deps.lazyOfflineFfaScores?.();
  return offline
    ? { scores: offline, localScoreId: 'local' }
    : { scores: deps.world.ffaScores, localScoreId: localId };
}

// Per-player alive clock — spawn/join stamps, cleared on death. The
// scoreboard polls it every frame, so dead→alive transitions in ANY
// source (wire events, tick isDead flips, offline bot respawns) reset it.
const aliveSince = new Map<string, number>();
/** Seconds alive, or null while dead. A first-seen-alive id stamps now —
 * join-time is the closest observable the client has for pre-existing
 * players. */
function aliveSecs(id: string, dead: boolean, now: number): number | null {
  if (dead) { aliveSince.delete(id); return null; }
  let at = aliveSince.get(id);
  if (at === undefined) { at = now; aliveSince.set(id, at); }
  return Math.floor((now - at) / 1000);
}

// Scoreboard rows: local player first, then remotes sorted by frags desc
function updateScoreboard(deps: RemotesDeps): void {
  const hud = deps.lazyHud();
  if (!hud.scoreboardVisible) return;
  const nm = deps.lazyNetworkManager();
  const localId = nm.getLocalPlayerId();
  // Offline combat uses the stable authority id `local`; the generated
  // network id only exists for wire rooms. Read the matching score key
  // while keeping the visible row name consistent with online play.
  const { scores: ffa, localScoreId } = scoreboardScores(deps, nm, localId);
  // My frags land under TWO keys: wire kills credit the network id
  // (playerKill broadcast), kills on the client-side fill bots credit
  // 'local' (botKill's authority id). Sum them — reading only one key
  // silently dropped every kill that went through the other path.
  const selfFrags = (deps.world.killCounts.get('local') ?? 0)
    + (localScoreId === 'local' ? 0 : deps.world.killCounts.get(localScoreId) ?? 0);
  const now = Date.now();
  const rows = [{ name: localId, frags: selfFrags, score: ffa.get(localScoreId) ?? null, ping: nm.getPing(), net: nm.getTransportTier() ?? null, self: true, dead: deps.lazyPlayer().isDead, team: deps.world.localTeam, sheep: deps.lazyPlayerSheep?.().shown ?? null, alive: aliveSecs(localId, deps.lazyPlayer().isDead, now) }];
  // net is string|null — 'bot' rows carry a label, not a transport tier.
  const remoteRows: { name: string; frags: number; score: number | null; ping: number | null; net: string | null; self: boolean; dead: boolean; team?: TeamId; sheep?: number | null; bot?: boolean; alive?: number | null }[] = [...nm.getPlayers().keys()]
    .filter(id => id !== localId && isRemoteActive(deps, id, nm.getPlayers()))
    .map(id => {
      const ps = nm.getPlayers().get(id);
      return { name: id, frags: deps.world.killCounts.get(id) ?? 0, score: ffa.get(id) ?? null, ping: ps?.ping ?? null, net: isBotId(id) ? 'bot' : (ps?.transport ?? null), self: false, dead: ps?.isDead ?? false, team: ps?.team, sheep: ps?.sheep ?? null, bot: isBotId(id), alive: aliveSecs(id, ps?.isDead ?? false, now) };
    });
  // Offline bots live in world.remotePlayers, not the network roster —
  // they'd be invisible on the scoreboard otherwise.
  for (const [id, rp] of deps.world.remotePlayers) {
    if (nm.getPlayers().has(id)) continue;
    // GameBot carries a team field; FFA bots get a self-id pseudo-team,
    // which must not count as a real team row.
    const t = (rp as { team?: string }).team;
    remoteRows.push({ name: id.replace('bot:', ''), frags: deps.world.killCounts.get(id) ?? 0, score: ffa.get(id) ?? null, ping: null, net: 'bot', self: false, dead: rp.isDead, team: t === 'alpha' || t === 'bravo' ? t : undefined, sheep: (rp as { sheepShown?: number; sheep?: number }).sheepShown ?? (rp as { sheep?: number }).sheep ?? null, bot: isBotId(id), alive: aliveSecs(id, rp.isDead, now) });
  }
  remoteRows.sort((a, b) => (b.score ?? b.frags) - (a.score ?? a.frags));
  hud.setScoreboardRows([...rows, ...remoteRows]);
  hud.setScoreboardTitle(scoreboardTitle(deps.world.mode, deps.world.mapName));
}

export function createRemotes(deps: RemotesDeps) {
  let lastSentPos = { x: 0, y: 0, z: 0 };
  let lastRemotePosLog = '';
  const lastTintOf = new Map<string, string>();
  let rosterPollT = 0;
  let wasConnected = true;

  deps.world.remotePlayers.hooks = makeRemoteHooks(deps);

  function getLastSentPos() { return lastSentPos; }
  function setLastSentPos(pos: { x: number; y: number; z: number }) {
    lastSentPos.x = pos.x; lastSentPos.y = pos.y; lastSentPos.z = pos.z;
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

    // Connected → disconnected: the wire map is already cleared, so the
    // prune below reaps the entities — but indicator ids that aren't
    // entity-keyed (flag:alpha/bravo) have no owner to clean them.
    // Sweep the whole overlay once on the transition or they freeze
    // mid-screen for the life of the session.
    if (wasConnected && !nm.isConnected()) deps.lazyHud().clearPlayerIndicators();
    wasConnected = nm.isConnected();

    const players = nm.getPlayers();
    const previousRemoteCount = deps.world.remotePlayers.size;

    const localPlayerId = nm.getLocalPlayerId();

    // Roster work — player list UI + join/leave log — is polled at 2Hz.
    // Per-position logging at 60Hz was a console flood, and building the
    // roster arrays every frame was pure GC churn; a join/leave rendered
    // half a second late loses nothing.
    rosterPollT -= dt;
    if (rosterPollT <= 0) {
      rosterPollT = 0.5;
      const rosterKey = [...players.keys()].filter(id => id !== localPlayerId).toSorted().join(',');
      if (rosterKey !== lastRemotePosLog) {
        lastRemotePosLog = rosterKey;
        deps.logger.info(`Remote roster: ${rosterKey || 'none'}`);
      }
    }

    players.forEach((playerState, playerId) => tickRemotePlayer(deps, lastTintOf, playerId, playerState, dt));
    const hud = deps.lazyHud();
    const cam = deps.lazyCamera();
    tickOnScreen(deps, cam);
    // Local bots ('bot:', 'dummy') aren't in the network roster, so the
    // forEach above never touches them — same red marker as real remotes.
    for (const [id, rp] of deps.world.remotePlayers) {
      if (players.has(id)) continue;
      if (rp.isDead) {
        hud.removePlayerIndicator(id);
      } else {
        // Local bots aren't network remotes — without this they'd jet
        // silently; wireJet carries the brain's real burn.
        if (isJetting(rp, false)) deps.lazyEffects().spawnJetpack(rp.position);
        // GameBot carries `team` ('alpha'/'bravo', own id in FFA) — plain
        // RemotePlayers have none and stay enemy red.
        const friendly = (rp as { team?: string }).team === deps.world.localTeam
          && (rp as { team?: string }).team !== undefined;
        hud.updatePlayerIndicator(id, rp.position, cam, { friendly, sheep: (rp as { sheepShown?: number; sheep?: number }).sheepShown ?? (rp as { sheep?: number }).sheep, bot: isBotId(id), cls: rp.armorClass });
      }
    }
    tickFlagMarkers(deps, localPlayerId, player.pos, hud, cam);
    cleanupRemotePlayers(deps, players);

    if (deps.world.remotePlayers.size !== previousRemoteCount) {
      deps.logger.debug(`Remote players in scene: ${deps.world.remotePlayers.size} | Scene children: ${deps.lazyScene().children.length}`);
    }
  }




  return { networkTick, updateScoreboard: () => updateScoreboard(deps), getLastSentPos, setLastSentPos };
}
