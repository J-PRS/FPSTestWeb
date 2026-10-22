import * as THREE from 'three';
import { STATUS } from '../../../shared/status.js';

import type { ChildLogger } from '../core/Logger.js';
import type { Terrain } from '../world/terrain.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { setFrustumVis } from '../entities/remoteVis.js';
import type { EffectsManager } from '../effects/effects.js';
import { emitLocomotionFx, isCarvingSki } from '../effects/locomotionFx.js';
import type { NetworkManager , RemotePlayerState } from '../networking/NetworkManager.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { HUD } from '../ui/hud.js';
import { rankRows, scoreboardTitle } from '../ui/hud/scoreboard.js';
import type { WorldState } from './worldState.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import { FLAG_STAND_TOP } from '../structures/structures.js';
import { settings } from '../core/settings.js';
import { isBotId, botRosterName } from '../../../shared/botNames.js';
import * as sfxWorld from '../core/sfx/world.js';
import { lastWeaponByPlayer } from './net/projectiles.js';

// Hostiles always read red — team colors are for your own side only.
const ENEMY_RED = 0xFF_33_33;

// Shared scratch for the per-tick offscreen test.
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _flagAnchor = new THREE.Vector3();
const _markPos = new THREE.Vector3();

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
    create: (id: string, state: WirePlayerState): RemotePlayer | undefined => {
      if (state.isDead) {return undefined;}
      const rp = new RemotePlayer(deps.lazyScene(), id, state.position, deps.lazyTerrain(), state.armorClass);
      rp.setClass(state.armorClass);
      return rp;
    },
    // Bots are hosted in the room sim — they never ping, so the
    // dead-socket gate can't apply to them or they render as ghosts.
    isLive: (id: string, state: WirePlayerState | undefined): boolean => isBotId(id) || state?.ping != null,
    onCreate: (id: string, rp: RemotePlayer): void => deps.logger.debug('CREATED remote player', { instanceId: rp.instanceId, playerId: id, total: deps.world.remotePlayers.size }),
    onRemove: (id: string): void => {
      deps.lazyHud().removePlayerIndicator(id);
      deps.lazyHealthBarSystem().forgetPlayer(id);
      sfxWorld.remoteMoveAudioGone(id);
      // aliveSince/lastWeaponByPlayer key on live ids — a leaver drops
      // here or the module maps grow one entry per departed player
      // forever. kill/death counts are NOT cleared: onRemove also fires
      // on the corpse→respawn entity swap, and zeroing the score there
      // reset every bot's K/D in the tab board on each respawn.
      aliveSince.delete(id);
      lastWeaponByPlayer.delete(id);
    },
  };
}

type WirePlayerState = RemotePlayerState;

function isRemoteActive(deps: RemotesDeps, playerId: string, players: Map<string, WirePlayerState>): boolean {
  return deps.world.remotePlayers.active(playerId, deps.world.remotePlayers.get(playerId), players.get(playerId));
}

// Status bitmask → per-effect visuals. One bit = one row; the next
// toggle effect lands here, nowhere else in the netcode. Returns false
// when cloaked — an enemy's HUD must give no trace (dust off an
// invisible skier is a giveaway). A teammate's cloak is different: it
// stays on screen wearing the ghost shimmer, so only enemies vanish.
function applyStatusVisuals(deps: RemotesDeps, playerId: string, remotePlayer: RemotePlayer, status: number, theirTeam: string | undefined): boolean {
  // Corpses hold no channels — the corpse window's row still streams the
  // pre-death bits until respawn clears them server-side, and a cloaked
  // corpse would render nothing at all.
  const s = remotePlayer.isDead ? 0 : status;
  const cloaked = Boolean(s & STATUS.CLOAK);
  const friendly = cloaked && Boolean(theirTeam) && theirTeam === deps.world.localTeam;
  remotePlayer.setCloakHidden(cloaked && !friendly);
  remotePlayer.setCloakGhosted(cloaked && friendly);
  remotePlayer.setShielded(Boolean(s & STATUS.SHIELD));
  remotePlayer.setMending(Boolean(s & STATUS.MEND));
  remotePlayer.setRegenAura(Boolean(s & STATUS.REGEN));
  remotePlayer.setDdAura(Boolean(s & STATUS.DD));
  remotePlayer.setCharged(Boolean(s & STATUS.CHARGED));
  if (!cloaked || friendly) {return true;}
  // Fire-reveal: his own shot left the shimmer window open — the marker
  // and bar stay up like any visible enemy until ghostT closes it.
  if (remotePlayer.ghostT > 0) {return true;}
  deps.lazyHud().removePlayerIndicator(playerId);
  deps.lazyHealthBarSystem().removeBar(playerId);
  return false;
}

// One jetting verdict for audio + trail: wireJet when a driver knows the
// real button, else the powered-climb heuristic.
function isJetting(rp: RemotePlayer, dead: boolean): boolean {
  if (dead) {return false;}
  return rp.wireJet ?? rp.vel.y > 4.5;
}



// Ski dust off a networked ski flag near the ground, plus the HUD
// name marker from the extrapolated position.
function tickRemoteCosmetics(deps: RemotesDeps, playerId: string, remotePlayer: RemotePlayer, playerState: WirePlayerState): void {
  const hud = deps.lazyHud();
  // The wire ski bit doubles as the animation claim — tuck when held,
  // run when released, regardless of how much momentum remains.
  const ski = !playerState.isDead && Boolean(playerState.ski);
  const jet = !playerState.isDead && Boolean(playerState.jet);
  remotePlayer.wireSki = ski;
  remotePlayer.wireJet = jet;
  // The wire has no onGround bit — same feet-vs-ground read the ski dust
  // always used. Only needed when carving, so idle frames skip the probes.
  let grounded = false;
  const v = remotePlayer.vel;
  if (ski) {
    const terrain = deps.lazyTerrain();
    const groundY = Math.max(terrain.getHeight(remotePlayer.position.x, remotePlayer.position.z), terrain.getRenderedHeight(remotePlayer.position.x, remotePlayer.position.z));
    grounded = remotePlayer.feetY - groundY < 0.8;
  }
  // Same shared pass the local player and offline bots use — one gate, one
  // pair of spawn calls, so a remote's trail matches anyone else's.
  const jetting = isJetting(remotePlayer, playerState.isDead);
  emitLocomotionFx(deps.lazyEffects(), remotePlayer.position, v, grounded, ski, jetting);
  const skiing = isCarvingSki(v, grounded, ski);
  sfxWorld.remoteMoveAudio(playerId, remotePlayer.position, v.length(), jetting, skiing, v, remotePlayer.armorClass);
  if (playerState.isDead) {
    hud.removePlayerIndicator(playerId);
  } else {
    // Teammates read green, everything else stays enemy red — FFA and
    // teamless modes leave `team` undefined so nothing turns friendly.
    const friendly = Boolean(playerState.team) && playerState.team === deps.world.localTeam;
    // Anchor at the RENDERED eye — the slope/lift pass can raise the
    // mesh ~2.5m over the logical feet; marking raw position sinks the
    // chevron into the body exactly when the lift is live.
    _markPos.copy(remotePlayer.position); _markPos.y += remotePlayer.renderLift;
    hud.updatePlayerIndicator(playerId, _markPos, deps.lazyCamera(), { friendly, sheep: playerState.sheep, bot: isBotId(playerId), cls: remotePlayer.armorClass, hp: playerState.health, held: playerState.held });
    // The number stays on the indicator; the crown renders the pile itself.
    remotePlayer.setHeld(playerState.held ?? 0);
  }
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
function aswAccrue(id: string, dead: boolean, grounded: boolean, skiing: boolean, dt: number): void {
  if (dead) { asw.delete(id); return; }
  let e = asw.get(id);
  if (!e) { e = { a: 0, s: 0, w: 0 }; asw.set(id, e); }
  if (!grounded) { e.a += dt; } else if (skiing) { e.s += dt; } else { e.w += dt; }
}



// Friend-or-foe marker: teammates wear their team's color, enemies are
// always red. Tint applies only when the wire team changes.
function applyTeamTint(deps: RemotesDeps, lastTintOf: Map<string, string>,
    playerId: string, remotePlayer: RemotePlayer, theirTeam: string | undefined): void {
  // Debug hitbox wireframe — friendly green, everyone else red. Runs every
  // tick (setHex is free) so teamless/FFA bodies read enemy-red, not the
  // constructor's default green.
  const friendly = Boolean(theirTeam) && theirTeam === deps.world.localTeam;
  remotePlayer.setColliderColor(friendly ? 0x00_FF_00 : ENEMY_RED);
  // Body marks — enemies carry the scarlet hull+rim (through-wall read);
  // allies get the quieter squad-green rim only. Bodies stay neutral.
  remotePlayer.model.setOutline(friendly ? null : 0xF0_4A_4A);
  remotePlayer.model.setRim(friendly ? 0x44_CC_55 : 0xF0_4A_4A);
  if (!theirTeam || theirTeam === lastTintOf.get(playerId)) {return;}
  lastTintOf.set(playerId, theirTeam);
  remotePlayer.setGizmoColor(theirTeam === deps.world.localTeam ? TEAM_COLORS[theirTeam] : ENEMY_RED);
}



// Per-remote-player frame work: create if new, hide if stale, tick, then cosmetics
function tickRemotePlayer(deps: RemotesDeps, lastTintOf: Map<string, string>,
    playerId: string, playerState: WirePlayerState, dt: number): void {
  const nm = deps.lazyNetworkManager();
  if (playerId === nm.getLocalPlayerId()) {return;}

  const remotePlayer = deps.world.remotePlayers.ensure(playerId, playerState);
  if (!remotePlayer) {return;}

  // Entity liveness mirrors roster truth every frame — the kill/respawn
  // events are just the fast path. A lost event leaves _isDead frozen
  // while ticks already say alive (roster heals, body stays a corpse:
  // the silent invisible-bot desync the hash can't flag because the
  // roster agrees).
  if (playerState.isDead !== remotePlayer.isDead) {
    if (playerState.isDead) {remotePlayer.playDeath();}
    else {remotePlayer.respawn(playerState.position);}
  }

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
  // Same grounded heuristic the ski dust uses — wire has no onGround bit.
  const tY = Math.max(deps.lazyTerrain().getHeight(remotePlayer.position.x, remotePlayer.position.z), deps.lazyTerrain().getRenderedHeight(remotePlayer.position.x, remotePlayer.position.z));
  aswAccrue(playerId, playerState.isDead, remotePlayer.feetY - tY < 0.8, Boolean(playerState.ski), dt);
  // Class rides every tick record because strict-tier role re-fits
  // (hof→heavy, capper→light) land mid-life on the server — the
  // silhouette must follow the sim's body, not the create-time class.
  if (remotePlayer.armorClass !== playerState.armorClass) {remotePlayer.setClass(playerState.armorClass);}

  // A decloak-revealed enemy (ghostT live from his own shot) reads like
  // any visible foe: HUD marker, team tint, ski dust — the cloak only
  // blanks him once the shimmer window closes.
  if (!applyStatusVisuals(deps, playerId, remotePlayer, playerState.status ?? 0, playerState.team) && remotePlayer.ghostT <= 0) {return;}
  applyTeamTint(deps, lastTintOf, playerId, remotePlayer, playerState.team);
  tickRemoteCosmetics(deps, playerId, remotePlayer, playerState);
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
      if (rp) {m.position.set(rp.pos.x, rp.pos.y + 0.4, rp.pos.z);} // shoulders, not boots
    } else if (m.position.distanceToSquared(marker.wirePos) > 1e-6) {
      m.position.lerp(marker.wirePos, 0.35);
    }
    _flagAnchor.set(m.position.x, m.position.y + 3.4, m.position.z);
    hud.updateFlagIndicator(`flag:${team}`, _flagAnchor, cam, team);
    // The stand's hollow socket marker sits at gem height — flag home
    // reads as a flag-over-stand pin stack; flag away leaves the empty
    // socket marking where it belongs. While the flag is home the socket
    // rides the flag diamond's anchor so the filled diamond nests inside
    // it — projecting both from home would leave them ~3m apart on screen.
    if (marker.homeKnown) {
      const home = deps.world.flagStates[team] === 'home';
      if (!home) {_flagAnchor.set(marker.home.x, marker.home.y + FLAG_STAND_TOP + 0.07, marker.home.z);}
      hud.updateFlagIndicator(`stand:${team}`, _flagAnchor, cam, team, 'stand');
    }
  }
}

const _nodeAnchor = new THREE.Vector3();
/** Conquest node pins — same DOM diamonds as the flags. net/nodes.ts
 *  decides WHICH nodes pin (cores + your frontier) via marker.show;
 *  this loop only projects. */
function tickNodeMarkers(deps: RemotesDeps, hud: HUD, cam: THREE.PerspectiveCamera): void {
  const marks = deps.world.nodeMarkers;
  if (marks.size === 0) {return;}
  for (const [id, m] of marks) {
    if (!m.show) {continue;}
    // Pin floats above the beam base — readable against the ring at
    // standoff range, clear of the pillar glow up close.
    _nodeAnchor.set(m.pos.x, m.pos.y + (m.core ? 12 : 7), m.pos.z);
    hud.updateFlagIndicator(`node:${id}`, _nodeAnchor, cam, m.owner === 'neutral' ? 'neutral' : m.owner, m.core ? 'stand' : 'flag');
  }
}

// Remove disconnected players and dead players that have shrunk to 0
function cleanupRemotePlayers(deps: RemotesDeps, players: Map<string, WirePlayerState>): void {
  // `bot:` entries are locally driven (Nugget Wars) — the network roster
  // knows nothing about them; cleanup is owned by TeamBots.
  // 'dummy' is the ?dummy debug body — gameLoop ticks it from a closure,
  // so pruning it would leave a disposed model animating forever.
  // Wire 'BOT-' ids are NOT exempt: they live and die by the roster like
  // humans, or a bot that left keeps an unticked frozen shell forever —
  // shootable, but every claim lands 'Shot: unknown target'.
  deps.world.remotePlayers.prune(
    (id): boolean => id.startsWith('bot:') || id.startsWith('dummy') || players.has(id),
    // Local bots/dummies keep their body across death+respawn — the death
    // shrink must NOT reap them or they respawn invisible and off-board.
    // A wire bot's corpse shrink may reap it: roster truth recreates it.
    (id): boolean => id.startsWith('bot:') || id.startsWith('dummy'),
  );
}

function scoreboardScores(deps: RemotesDeps, nm: NetworkManager, localId: string): { scores: Map<string, number>; localScoreId: string } {
  if (nm.isConnected()) {return { scores: deps.world.ffaScores, localScoreId: localId };}
  const offline = deps.lazyOfflineFfaScores?.();
  return offline
    ? { scores: offline, localScoreId: 'local' }
    : { scores: deps.world.ffaScores, localScoreId: localId };
}

// Per-player alive clock — spawn/join stamps, cleared on death. The
// scoreboard polls it every frame, so dead→alive transitions in ANY
// source (wire events, tick isDead flips, offline bot respawns) reset it.
const aliveSince = new Map<string, number>();

/** A/S/W split of the CURRENT life — ms buckets, wiped on death exactly
 *  like aliveSince. Ski reads as grounded-and-skiing; airborne ski time
 *  counts as air (you can't ski without a surface). */
const asw = new Map<string, { a: number; s: number; w: number }>();
function aswStr(id: string): string | null {
  const e = asw.get(id);
  if (!e) {return null;}
  const t = e.a + e.s + e.w;
  if (t <= 0) {return null;}
  const pct = (v: number): number => Math.round((v / t) * 100);
  return `${pct(e.a)}/${pct(e.s)}/${pct(e.w)}`;
}
function pruneAsw(live: Set<string>): void {
  for (const id of asw.keys()) {
    if (!live.has(id)) {asw.delete(id);}
  }
}

/** Seconds alive, or null while dead. A first-seen-alive id stamps now —
 * join-time is the closest observable the client has for pre-existing
 * players. */
function aliveSecs(id: string, dead: boolean, now: number): number | null {
  if (dead) { aliveSince.delete(id); return null; }
  let at = aliveSince.get(id);
  if (at === undefined) { at = now; aliveSince.set(id, at); }
  return Math.floor((now - at) / 1000);
}

/** A leaver who quit alive never trips the death prune — evict ids the
 *  current pass didn't query or the map holds every departed id forever. */
function pruneAliveSince(live: Set<string>): void {
  for (const id of aliveSince.keys()) {
    if (!live.has(id)) {aliveSince.delete(id);}
  }
}

let lastScoreboardAt = 0;
let scoreboardStale = true;

// Scoreboard rows: local player first, then remotes sorted by frags desc
function updateScoreboard(deps: RemotesDeps): void {
  const hud = deps.lazyHud();
  // Rows rebuild at ~4Hz, not per frame — a full roster Set+sort every
  // rendered frame is pure churn for a display the eye can't resolve
  // past a few updates a second anyway. Open edge forces one immediate
  // pass so the board never shows a stale frame.
  const frameNow = performance.now();
  if (!hud.scoreboardVisible) {scoreboardStale = true; return;}
  if (!scoreboardStale && frameNow - lastScoreboardAt < 250) {return;}
  scoreboardStale = false;
  lastScoreboardAt = frameNow;
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
  const selfDeaths = (deps.world.deathCounts.get('local') ?? 0)
    + (localScoreId === 'local' ? 0 : deps.world.deathCounts.get(localScoreId) ?? 0);
  const now = Date.now();
  const rows = [{ name: settings.get('fps-name') || localId, frags: selfFrags, deaths: selfDeaths, score: ffa.get(localScoreId) ?? null, ping: nm.serverPingMs == null ? nm.getPing() : `${nm.getPing()}/${Math.round(nm.serverPingMs)}`, net: nm.getTransportTier() ?? null, self: true, dead: deps.lazyPlayer().isDead, team: deps.world.localTeam, sheep: deps.lazyPlayerSheep?.().shown ?? null, alive: aliveSecs(localId, deps.lazyPlayer().isDead, now), cls: deps.lazyPlayer().appliedClass, asw: aswStr(localId) }];
  // net is string|null — 'bot' rows carry a label, not a transport tier.
  const queriedIds = new Set<string>([localId]);
  const remoteRows: { name: string; frags: number; deaths: number; score: number | null; ping: number | null; net: string | null; self: boolean; dead: boolean; team?: TeamId; sheep?: number | null; bot?: boolean; alive?: number | null; cls?: string; asw?: string | null }[] = [...nm.getPlayers().keys()]
    .filter((id): boolean => id !== localId && isRemoteActive(deps, id, nm.getPlayers()))
    .map(id => {
      queriedIds.add(id);
      const ps = nm.getPlayers().get(id);
      return { name: isBotId(id) ? botRosterName(id) : (ps?.name ?? id), frags: deps.world.killCounts.get(id) ?? 0, deaths: deps.world.deathCounts.get(id) ?? 0, score: ffa.get(id) ?? null, ping: ps?.ping ?? null, net: isBotId(id) ? 'bot' : (ps?.transport ?? null), self: false, dead: ps?.isDead ?? false, team: ps?.team, sheep: ps?.sheep ?? null, bot: isBotId(id), alive: aliveSecs(id, ps?.isDead ?? false, now), cls: ps?.armorClass, asw: aswStr(id) };
    });
  // Offline bots live in world.remotePlayers, not the network roster —
  // they'd be invisible on the scoreboard otherwise.
  for (const [id, rp] of deps.world.remotePlayers) {
    if (nm.getPlayers().has(id)) {continue;}
    queriedIds.add(id);
    // GameBot carries a team field; FFA bots get a self-id pseudo-team,
    // which must not count as a real team row.
    const t = (rp as { team?: string }).team;
    remoteRows.push({ name: botRosterName(id), frags: deps.world.killCounts.get(id) ?? 0, deaths: deps.world.deathCounts.get(id) ?? 0, score: ffa.get(id) ?? null, ping: null, net: 'bot', self: false, dead: rp.isDead, team: t === 'alpha' || t === 'bravo' ? t : undefined, sheep: (rp as { sheepShown?: number; sheep?: number }).sheepShown ?? (rp as { sheep?: number }).sheep ?? null, bot: isBotId(id), alive: aliveSecs(id, rp.isDead, now), cls: rp.armorClass, asw: aswStr(id) });
  }
  // Self sorts into the ranking like everyone else — pinning the local
  // row to the top read as "unordered" whenever the leader wasn't you.
  const allRows = [...rows, ...remoteRows];
  const ranked = rankRows(deps.world.mode, allRows);
  pruneAliveSince(queriedIds);
  pruneAsw(queriedIds);
  hud.setScoreboardRows(ranked);
  hud.setScoreboardTitle(scoreboardTitle(deps.world.mode, deps.world.mapName));
}

export function createRemotes(deps: RemotesDeps) {
  const lastSentPos = { x: 0, y: 0, z: 0 };
  let lastRemotePosLog = '';
  const lastTintOf = new Map<string, string>();
  let rosterPollT = 0;
  let wasConnected = true;

  deps.world.remotePlayers.hooks = makeRemoteHooks(deps);
  // Tint memory keys on ids — same leaver-leak class as aliveSince.
  const prevOnRemove = deps.world.remotePlayers.hooks.onRemove;
  deps.world.remotePlayers.hooks.onRemove = (id, ent, reason): void => {
    lastTintOf.delete(id);
    prevOnRemove?.(id, ent, reason);
  };

  function getLastSentPos(): { x: number; y: number; z: number; } { return lastSentPos; }
  function setLastSentPos(pos: { x: number; y: number; z: number }): void {
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
    const hist = deps.world.localPosHistory;
    hist.push({ t: performance.now(), x: player.pos.x, y: player.pos.y, z: player.pos.z, vx: player.vel.x, vy: player.vel.y, vz: player.vel.z });
    if (hist.length > 180) {hist.shift();}
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
    if (wasConnected && !nm.isConnected()) {deps.lazyHud().clearPlayerIndicators();}
    wasConnected = nm.isConnected();

    const players = nm.getPlayers();
    const previousRemoteCount = deps.world.remotePlayers.size;

    const localPlayerId = nm.getLocalPlayerId();
    aswAccrue(localPlayerId, player.isDead, player.onGround, player.skiing, dt);

    // Roster work — player list UI + join/leave log — is polled at 2Hz.
    // Per-position logging at 60Hz was a console flood, and building the
    // roster arrays every frame was pure GC churn; a join/leave rendered
    // half a second late loses nothing.
    rosterPollT -= dt;
    if (rosterPollT <= 0) {
      rosterPollT = 0.5;
      const rosterKey = [...players.keys()].filter((id): boolean => id !== localPlayerId).toSorted().join(',');
      if (rosterKey !== lastRemotePosLog) {
        lastRemotePosLog = rosterKey;
        deps.logger.info(`Remote roster: ${rosterKey || 'none'}`);
      }
    }

    players.forEach((playerState, playerId): void => tickRemotePlayer(deps, lastTintOf, playerId, playerState, dt));
    const hud = deps.lazyHud();
    const cam = deps.lazyCamera();
    tickOnScreen(deps, cam);
    // Local bots ('bot:', 'dummy') aren't in the network roster, so the
    // forEach above never touches them — same red marker as real remotes.
    for (const [id, rp] of deps.world.remotePlayers) {
      if (players.has(id)) {continue;}
      const gb = rp as { grounded?: boolean; wireSki?: boolean };
      if (rp.isDead) {
        hud.removePlayerIndicator(id);
      } else {
        // Local bots aren't network remotes — they used to jet silently and
        // leave NO ski dust at all. Same shared pass, so a bot's trail reads
        // exactly like a human's.
        emitLocomotionFx(deps.lazyEffects(), rp.position, rp.vel, gb.grounded ?? true, Boolean(gb.wireSki), isJetting(rp, false));
        // GameBot carries `team` ('alpha'/'bravo', own id in FFA) — plain
        // RemotePlayers have none and stay enemy red.
        const friendly = (rp as { team?: string }).team === deps.world.localTeam
          && (rp as { team?: string }).team !== undefined;
        _markPos.copy(rp.position); _markPos.y += rp.renderLift;
        hud.updatePlayerIndicator(id, _markPos, cam, { friendly, sheep: (rp as { sheepShown?: number; sheep?: number }).sheepShown ?? (rp as { sheep?: number }).sheep, bot: isBotId(id), cls: rp.armorClass, hp: (rp as { botHp?: number }).botHp });
      }
      aswAccrue(id, rp.isDead, gb.grounded ?? true, gb.wireSki ?? false, dt);
    }
    tickFlagMarkers(deps, localPlayerId, player.pos, hud, cam);
    tickNodeMarkers(deps, hud, cam);
    cleanupRemotePlayers(deps, players);

    if (deps.world.remotePlayers.size !== previousRemoteCount) {
      deps.logger.debug(`Remote players in scene: ${deps.world.remotePlayers.size} | Scene children: ${deps.lazyScene().children.length}`);
    }
  }




  return { networkTick, updateScoreboard: (): void => updateScoreboard(deps), getLastSentPos, setLastSentPos };
}
