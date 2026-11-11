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
import { rankRows, scoreboardTitle, aswBucket, type AswSplit, type SbRow } from '../ui/hud/scoreboard.js';
import type { WorldState } from './worldState.js';
import { TEAM_COLORS } from '../../../shared/teams.js';
import { CLASS_STATS } from '../../../shared/botClasses.js';
import { FLAG_STAND_TOP } from '../structures/structures.js';
import { settings } from '../core/settings.js';
import { MAX_HEALTH } from '../core/config.js';
import { isBotId, botRosterName } from '../../../shared/botNames.js';
import * as sfxWorld from '../core/sfx/world.js';
import { lastWeaponByPlayer } from './net/projectiles.js';
import { gibRemoteBody } from './net/playerKill.js';
import { sampleRemoteGhosts } from './ghostTrace.js';
import { intelContact } from './intel.js';
import { debugOverlaysOn } from '../ui/hud/indicators.js';
import { urlParams } from '../core/params.js';

// Hostiles always read red - team colors are for your own side only.
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
  /** Local sheep meter - the self row's sheep cell reads the same
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
      // Roster-declared weapon - the real gun instead of the placeholder
      // prop for remotes we haven't seen fire yet.
      if (state.weapon !== undefined) {rp.model.setWeapon(state.weapon);}
      return rp;
    },
    // Bots are hosted in the room sim - they never ping, so the
    // dead-socket gate can't apply to them or they render as ghosts.
    isLive: (id: string, state: WirePlayerState | undefined): boolean => isBotId(id) || state?.ping != null,
    onCreate: (id: string, rp: RemotePlayer): void => deps.logger.debug('CREATED remote player', { instanceId: rp.instanceId, playerId: id, total: deps.world.remotePlayers.size }),
    onRemove: (id: string): void => {
      deps.lazyHud().removePlayerIndicator(id);
      deps.lazyHealthBarSystem().forgetPlayer(id);
      sfxWorld.remoteMoveAudioGone(id);
      // aliveSince/lastWeaponByPlayer key on live ids - a leaver drops
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
// when cloaked - an enemy's HUD must give no trace (dust off an
// invisible skier is a giveaway). A teammate's cloak is different: it
// stays on screen wearing the ghost shimmer, so only enemies vanish.
// Standalone so demo playback drives the same lanes - the live caller
// passes world/hud from RemotesDeps, playback from its own lifecycle.
export function applyStatusVisuals(localTeam: string | undefined, hud: HUD, removeBar: ((id: string) => void) | null, playerId: string, remotePlayer: RemotePlayer, status: number, theirTeam: string | undefined): boolean {
  // Corpses hold no channels - the corpse window's row still streams the
  // pre-death bits until respawn clears them server-side, and a cloaked
  // corpse would render nothing at all.
  const s = remotePlayer.isDead ? 0 : status;
  const cloaked = Boolean(s & STATUS.CLOAK);
  const friendly = cloaked && Boolean(theirTeam) && theirTeam === localTeam;
  remotePlayer.setCloakHidden(cloaked && !friendly);
  remotePlayer.setCloakGhosted(cloaked && friendly);
  remotePlayer.setShielded(Boolean(s & STATUS.SHIELD));
  remotePlayer.setMending(Boolean(s & STATUS.MEND));
  remotePlayer.setRegenAura(Boolean(s & STATUS.REGEN));
  remotePlayer.setDdAura(Boolean(s & STATUS.DD));
  remotePlayer.setCharged(Boolean(s & STATUS.CHARGED));
  if (!cloaked || friendly) {return true;}
  // Fire-reveal: his own shot left the shimmer window open - the marker
  // and bar stay up like any visible enemy until ghostT closes it.
  if (remotePlayer.ghostT > 0) {return true;}
  hud.removePlayerIndicator(playerId);
  removeBar?.(playerId);
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
  // The wire ski bit doubles as the animation claim - tuck when held,
  // run when released, regardless of how much momentum remains.
  const ski = !playerState.isDead && Boolean(playerState.ski);
  const jet = !playerState.isDead && Boolean(playerState.jet);
  remotePlayer.wireSki = ski;
  remotePlayer.wireJet = jet;
  // The wire has no onGround bit - same feet-vs-ground read the ski dust
  // always used. Only needed when carving, so idle frames skip the probes.
  let grounded = false;
  const v = remotePlayer.vel;
  if (ski) {
    const terrain = deps.lazyTerrain();
    const groundY = Math.max(terrain.getHeight(remotePlayer.position.x, remotePlayer.position.z), terrain.getRenderedHeight(remotePlayer.position.x, remotePlayer.position.z));
    grounded = remotePlayer.feetY - groundY < 0.8;
  }
  // Same shared pass the local player and offline bots use - one gate, one
  // pair of spawn calls, so a remote's trail matches anyone else's.
  const jetting = isJetting(remotePlayer, playerState.isDead);
  emitLocomotionFx(deps.lazyEffects(), remotePlayer.position, v, grounded, ski, jetting);
  const skiing = isCarvingSki(v, grounded, ski);
  sfxWorld.remoteMoveAudio(playerId, remotePlayer.position, v.length(), jetting, skiing, v, remotePlayer.armorClass);
  markIndicator(deps, hud, playerId, remotePlayer, playerState);
}

/** HUD name-marker pass: dead/undetected ids get the indicator pulled;
 *  live contacts mark the rendered eye (or the last-known spot when the
 *  intel contact went stale). */
function markIndicator(deps: RemotesDeps, hud: HUD, playerId: string, remotePlayer: RemotePlayer, playerState: WirePlayerState): void {
  if (playerState.isDead) {
    hud.removePlayerIndicator(playerId);
    return;
  }
  // Teammates read green, everything else stays enemy red - FFA and
  // teamless modes leave `team` undefined so nothing turns friendly.
  const friendly = Boolean(playerState.team) && playerState.team === deps.world.localTeam;
  // IFF gate: in connected play an enemy marker exists only while the
  // server's intel feed detects him (sensor net or allied LOS). Tilde
  // overlays / F1 / offline play bypass - debug visibility, not law.
  const nm = deps.lazyNetworkManager();
  const contact = friendly ? undefined : intelContact(playerId);
  const seeAll = !nm.isConnected() || debugOverlaysOn() || urlParams.debug;
  if (!friendly && !seeAll && !contact) {
    hud.removePlayerIndicator(playerId);
    return;
  }
  // Anchor at the RENDERED eye - the slope/lift pass can raise the
  // mesh ~2.5m over the logical feet; marking raw position sinks the
  // chevron into the body exactly when the lift is live.
  _markPos.copy(remotePlayer.position); _markPos.y += remotePlayer.renderLift;
  // A lingering contact marks where he WAS (last-known), ghosted -
  // never where he is now.
  const mem = Boolean(contact && !contact.fresh);
  if (mem) {_markPos.set(contact!.x, contact!.y, contact!.z);}
  // Unnamed humans show their id minus the 'player_' prefix - still
  // marks them as a real person vs a bot's HP number.
  hud.updatePlayerIndicator(playerId, _markPos, deps.lazyCamera(), { friendly, mem, sheep: playerState.sheep, bot: isBotId(playerId), cls: remotePlayer.armorClass, hp: playerState.health, held: playerState.held, name: playerState.name ?? playerId.replace(/^player_/, '') });
  // The number stays on the indicator; the crown renders the pile itself.
  remotePlayer.setHeld(playerState.held ?? 0);
}

/** Offscreen flag for the anim gate - one frustum extraction per frame,
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
/** feetY - terrain height, cached ~5Hz per id. Shared by wire remotes,
 *  local bots, and the local player - one sampler, one truth. The maps
 *  live next to aswStr below; safe - this only runs at tick time. */
function aswAltFor(id: string, x: number, z: number, feetY: number, terrain: Terrain, dt: number): number {
  const gt = (aswAltT.get(id) ?? 0) - dt;
  if (gt <= 0) {
    aswAltT.set(id, 0.2);
    const tY = Math.max(terrain.getHeight(x, z), terrain.getRenderedHeight(x, z));
    const alt = feetY - tY;
    aswAlt.set(id, alt);
    return alt;
  }
  aswAltT.set(id, gt);
  return aswAlt.get(id) ?? 0;
}
function aswAccrue(id: string, dead: boolean, alt: number, skiing: boolean, dt: number, speed = 0): void {
  if (dead) { asw.delete(id); return; }
  let e = asw.get(id);
  if (!e) { e = { ha: 0, a: 0, s: 0, w: 0, st: 0, i: 0 }; asw.set(id, e); }
  // alt = feetY - terrain height. >5m reads as high air (jet climb, big
  // drop); 0.8-5m is ordinary air (ski crest, hop, jump arc). Bucket
  // order/thresholds live in scoreboard.aswBucket - the feet gizmo reads
  // the same function, so ring color and column can never drift.
  e[aswBucket(alt, speed, skiing)] += dt;
}

// LOCOMOTION, not gait: a circling bot shows 80% ski and ~0 net travel.
// loco = displacement rate over 1s/5s/10s/15s windows - a bowl-circler
// reads ~0 at every window (loops fool a single 30s mark); a real
// transiting player stays high across all of them.
const locoRing = new Map<string, { x: number; z: number; t: number }[]>();
const LOCO_WINS = [1000, 2000, 5000, 10_000, 15_000];
function locoNote(id: string, dead: boolean, x: number, z: number): void {
  const now = performance.now();
  if (dead) { locoRing.delete(id); return; }
  const ring = locoRing.get(id) ?? [];
  ring.push({ x, z, t: now });
  while (ring.length > 1 && now - ring[0].t > 16_000) {ring.shift();}
  locoRing.set(id, ring);
}
/** Per-window displacement rates (1/2/5/10/15s), '-' per unfilled window. */
function locoVals(id: string): string[] {
  const ring = locoRing.get(id);
  if (!ring || ring.length < 2) {return [];}
  const now = performance.now();
  const cur = ring[ring.length - 1];
  return LOCO_WINS.map((win): string => {
    const cutoff = now - win;
    let anchor: { x: number; z: number; t: number } | undefined;
    for (let i = ring.length - 1; i >= 0; i -= 1) {
      if (ring[i].t <= cutoff) {anchor = ring[i]; break;}
    }
    if (!anchor || now - anchor.t < win * 0.5) {return '-';}
    const d = Math.hypot(cur.x - anchor.x, cur.z - anchor.z);
    return (d / ((now - anchor.t) / 1000)).toFixed(0);
  });
}
const locoStr = (id: string): string => { const v = locoVals(id); return v.length > 0 ? v.join('/') : '-'; };



// Friend-or-foe marker: teammates wear their team's color, enemies are
// always red. Tint applies only when the wire team changes. Exported for
// the demo playback lane - same reason as applyStatusVisuals.
export function applyTeamTint(localTeam: string | undefined, lastTintOf: Map<string, string>,
    playerId: string, remotePlayer: RemotePlayer, theirTeam: string | undefined): void {
  // Debug hitbox wireframe - friendly green, everyone else red. Runs every
  // tick (setHex is free) so teamless/FFA bodies read enemy-red, not the
  // constructor's default green.
  const friendly = Boolean(theirTeam) && theirTeam === localTeam;
  remotePlayer.setColliderColor(friendly ? 0x00_FF_00 : ENEMY_RED);
  // Body marks - enemies carry the scarlet hull+rim (through-wall read);
  // allies get the quieter squad-green rim only. Bodies stay neutral.
  remotePlayer.model.setOutline(friendly ? null : 0xF0_4A_4A);
  remotePlayer.model.setRim(friendly ? 0x44_CC_55 : 0xF0_4A_4A);
  if (!theirTeam || theirTeam === lastTintOf.get(playerId)) {return;}
  lastTintOf.set(playerId, theirTeam);
  remotePlayer.setGizmoColor(theirTeam === localTeam ? TEAM_COLORS[theirTeam as 'alpha' | 'bravo'] : ENEMY_RED);
}



// Per-remote-player frame work: create if new, hide if stale, tick, then cosmetics
function tickRemotePlayer(deps: RemotesDeps, lastTintOf: Map<string, string>,
    playerId: string, playerState: WirePlayerState, dt: number): void {
  noteDeps(deps);
  wireRoster.set(playerId, playerState);
  const nm = deps.lazyNetworkManager();
  if (playerId === nm.getLocalPlayerId()) {return;}

  const remotePlayer = deps.world.remotePlayers.ensure(playerId, playerState);
  if (!remotePlayer) {return;}

  // Entity liveness mirrors roster truth every frame - the kill/respawn
  // events are just the fast path. A lost event leaves _isDead frozen
  // while ticks already say alive (roster heals, body stays a corpse:
  // the silent invisible-bot desync the hash can't flag because the
  // roster agrees).
  if (playerState.isDead !== remotePlayer.isDead) {
    if (playerState.isDead) {
      remotePlayer.playDeath();
      // Same hide+gib outcome as the kill wire — the isDead tick can beat
      // a wid-queued playerKill event; without this the corpse flails
      // visibly until the event lands (or forever if it's lost).
      gibRemoteBody(deps, remotePlayer, playerState.team);
    }
    else {remotePlayer.respawn(playerState.position);}
  }

  // Hide stale remote players - backgrounded tabs keep the socket open but
  // stop sending updates, leaving ghosts standing around. 60s grace covers
  // genuine packet loss; dead reckoning handles shorter gaps. Players that
  // never reported ping (>5s without one) are dead sockets - hide them too.
  const inactive = !deps.world.remotePlayers.active(playerId, remotePlayer, nm.getPlayers().get(playerId));
  deps.world.remotePlayers.setStale(remotePlayer, inactive);
  if (inactive) {
    deps.lazyHud().removePlayerIndicator(playerId);
    deps.lazyHealthBarSystem().removeBar(playerId);
    sfxWorld.remoteMoveAudioGone(playerId);
    return;
  }

  // tick() drives interpolation + dead reckoning and internally advances
  // the AnimationMixer - a second model.update here would 2x animations.
  remotePlayer.tick(dt, deps.lazyCamera().position);
  // Same grounded heuristic the ski dust uses - wire has no onGround bit.
  // It feeds the scoreboard's asw column, so a ~5Hz cache is plenty:
  // 32 unconditional height samples/frame was ~2.3% of a throttled CPU.
  // The cache stores clearance (feetY - terrain), not a boolean - the
  // asw sampler splits ordinary air (<5m) from high air (>5m).
  const alt = aswAltFor(playerId, remotePlayer.position.x, remotePlayer.position.z, remotePlayer.feetY, deps.lazyTerrain(), dt);
  aswAccrue(playerId, playerState.isDead, alt, Boolean(playerState.ski), dt, remotePlayer.vel.length());
  locoNote(playerId, playerState.isDead, remotePlayer.position.x, remotePlayer.position.z);
  // Class rides every tick record because strict-tier role re-fits
  // (hof→heavy, capper→light) land mid-life on the server - the
  // silhouette must follow the sim's body, not the create-time class.
  if (remotePlayer.armorClass !== playerState.armorClass) {remotePlayer.setClass(playerState.armorClass);}

  // A decloak-revealed enemy (ghostT live from his own shot) reads like
  // any visible foe: HUD marker, team tint, ski dust - the cloak only
  // blanks him once the shimmer window closes.
  if (!applyStatusVisuals(deps.world.localTeam, deps.lazyHud(), (id): void => { deps.lazyHealthBarSystem().removeBar(id); }, playerId, remotePlayer, playerState.status ?? 0, playerState.team) && remotePlayer.ghostT <= 0) {return;}
  applyTeamTint(deps.world.localTeam, lastTintOf, playerId, remotePlayer, playerState.team);
  tickRemoteCosmetics(deps, playerId, remotePlayer, playerState);
}

/** CTF flag diamonds - projected every frame like player indicators.
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
    // The stand's hollow socket marker sits at gem height - flag home
    // reads as a flag-over-stand pin stack; flag away leaves the empty
    // socket marking where it belongs. While the flag is home the socket
    // rides the flag diamond's anchor so the filled diamond nests inside
    // it - projecting both from home would leave them ~3m apart on screen.
    if (marker.homeKnown) {
      const home = deps.world.flagStates[team] === 'home';
      if (!home) {_flagAnchor.set(marker.home.x, marker.home.y + FLAG_STAND_TOP + 0.07, marker.home.z);}
      hud.updateFlagIndicator(`stand:${team}`, _flagAnchor, cam, team, 'stand');
    }
  }
}

const _nodeAnchor = new THREE.Vector3();
/** Conquest node pins - same DOM diamonds as the flags. net/nodes.ts
 *  decides WHICH nodes pin (cores + your frontier) via marker.show;
 *  this loop only projects. */
function tickNodeMarkers(deps: RemotesDeps, hud: HUD, cam: THREE.PerspectiveCamera): void {
  const marks = deps.world.nodeMarkers;
  if (marks.size === 0) {return;}
  for (const [id, m] of marks) {
    if (!m.show) {continue;}
    // Pin floats above the beam base - readable against the ring at
    // standoff range, clear of the pillar glow up close.
    _nodeAnchor.set(m.pos.x, m.pos.y + (m.core ? 12 : 7), m.pos.z);
    hud.updateFlagIndicator(`node:${id}`, _nodeAnchor, cam, m.owner === 'neutral' ? 'neutral' : m.owner, m.core ? 'stand' : 'flag');
  }
}

// Remove disconnected players and dead players that have shrunk to 0
function cleanupRemotePlayers(deps: RemotesDeps, players: Map<string, WirePlayerState>): void {
  // `bot:` entries are locally driven (Nugget Wars) - the network roster
  // knows nothing about them; cleanup is owned by TeamBots.
  // 'dummy' is the ?dummy debug body - gameLoop ticks it from a closure,
  // so pruning it would leave a disposed model animating forever.
  // Wire 'BOT-' ids are NOT exempt: they live and die by the roster like
  // humans, or a bot that left keeps an unticked frozen shell forever -
  // shootable, but every claim lands 'Shot: unknown target'.
  deps.world.remotePlayers.prune(
    (id): boolean => id.startsWith('bot:') || id.startsWith('dummy') || players.has(id),
    // Local bots/dummies keep their body across death+respawn - the death
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

// Per-player alive clock - spawn/join stamps, cleared on death. The
// scoreboard polls it every frame, so dead→alive transitions in ANY
// source (wire events, tick isDead flips, offline bot respawns) reset it.
const aliveSince = new Map<string, number>();

/** HA/A/S/W/ST/I split of the CURRENT life - ms buckets, wiped on death
 *  exactly like aliveSince. Ski reads as grounded-and-skiing; airborne
 *  ski time counts as air (you can't ski without a surface). "high air"
 *  is >5m above terrain - jet climbs and big drops, not crest hops.
 *  "idle" is grounded under 1 m/s; "still" is grounded under 5. */
const asw = new Map<string, { ha: number; a: number; s: number; w: number; st: number; i: number }>();
// Clearance cache for the asw sampler - refreshed ~5Hz per remote.
const aswAlt = new Map<string, number>();
const aswAltT = new Map<string, number>();
function aswStr(id: string): AswSplit | null {
  const e = asw.get(id);
  if (!e) {return null;}
  const t = e.ha + e.a + e.s + e.w + e.st + e.i;
  if (t <= 0) {return null;}
  const pct = (v: number): number => Math.round((v / t) * 100);
  return { ha: pct(e.ha), a: pct(e.a), s: pct(e.s), w: pct(e.w), st: pct(e.st), i: pct(e.i) };
}
// Alt+Q hook - diagDump can't import this module (core->game edge), so
// the dump reads the split through a window provider like __labDump.
function dumpSheep(rp: RemotePlayer): number | string {
  const v = (rp as { sheepShown?: number }).sheepShown ?? (rp as { sheep?: number }).sheep;
  return v === undefined ? '-' : Number(v.toFixed(2));
}
function dumpPingNet(id: string, wr: { ping?: number | null; transport?: string | null; team?: string } | undefined): [string, string] {
  if (isBotId(id)) {return ['bot', 'bot'];}
  return [String(wr?.ping ?? '-'), String(wr?.transport ?? '-')];
}
// cur/max for the dump's hp column - the wire ships current health only,
// but max is class-derived (perk maxHealth is always 0), so remotes get
// the same number the server computed.
function dumpHp(cur: number | undefined, cls: string | undefined): string {
  if (cur === undefined || !Number.isFinite(cur)) {return '-';}
  const max = MAX_HEALTH + (cls !== undefined && cls in CLASS_STATS ? CLASS_STATS[cls as keyof typeof CLASS_STATS].maxHealth : 0);
  return `${Math.round(cur)}/${max}`;
}
function gameDumpRow(w: WorldState, id: string, rp: RemotePlayer, now: number): string {
  const s = aswStr(id);
  const wr = wireRoster.get(id);
  const team = wr?.team ?? (rp as { team?: string }).team ?? '-';
  const [ping, net] = dumpPingNet(id, wr);
  // Hero resolve: the escalation dial in raw 0-1 - balancing reads it
  // straight, no inference from fight outcomes. Offline bots expose
  // brain.skill through GameBot's getter; wire remotes don't carry it.
  const rsv = (rp as { skill?: { resolve?: number } }).skill?.resolve;
  const ai = (rp as { aiDump?: string }).aiDump;
  const hp = dumpHp(wr?.health ?? (rp as { health?: number }).health, rp.armorClass);
  return `  ${id.slice(0, 20).padEnd(20)} ${String(team).padEnd(9)} ${String(rp.armorClass ?? '-').padEnd(8)} ${String(w.killCounts.get(id) ?? 0).padStart(2)} ${String(w.deathCounts.get(id) ?? 0).padStart(2)} ${String(w.ffaScores.get(id) ?? 0).padStart(5)} ${hp.padStart(8)} ${String(dumpSheep(rp)).padStart(5)} ${String(aliveSecs(id, rp.isDead, now) ?? '-').padStart(5)} ${rsv === undefined ? '-' : rsv.toFixed(2).padStart(4)} ${locoStr(id).padEnd(13)} ${ping.padStart(4)} ${net.padEnd(5)} ${s ? `${s.ha}/${s.a}/${s.s}/${s.w}/${s.st}/${s.i}` : '-'}${ai ? ` ${ai}` : ''}`;
}
if (typeof window !== 'undefined') {
  (window as { __aswDump?: () => string[] }).__aswDump = (): string[] => {
    const lines: string[] = [];
    for (const id of asw.keys()) {
      const s = aswStr(id); // percentages of life, same numbers the column shows
      if (s) {lines.push(`  asw ${id.slice(0, 20)} ${s.ha}/${s.a}/${s.s}/${s.w}/${s.st}/${s.i}`);}
    }
    return lines;
  };
  // Shift+Alt+Q: game-STATE dump for balancing/testing - scoreboard rows
  // (name/team/frags/deaths/score) + team tally + ASW split. Not logs.
  (window as { __gameDump?: () => string[] }).__gameDump = gameDump;
}
// The local player's kills/deaths split across two keys - 'local' and
// the score-id when it's a real player id (scoreboardScores decides).
function selfCount(map: Map<string, number>, localScoreId: string): number {
  return (map.get('local') ?? 0) + (localScoreId === 'local' ? 0 : map.get(localScoreId) ?? 0);
}
function gameDumpSelfRow(d: RemotesDeps, w: WorldState, now: number): string {
  const nm = d.lazyNetworkManager();
  const localId = nm.getLocalPlayerId();
  const { scores, localScoreId } = scoreboardScores(d, nm, localId);
  const self = d.lazyPlayer();
  const selfF = selfCount(w.killCounts, localScoreId);
  const selfD = selfCount(w.deathCounts, localScoreId);
  const ss = aswStr(localId);
  const shown = d.lazyPlayerSheep?.().shown;
  return `  ${String(settings.get('fps-name') || localId).slice(0, 20).padEnd(20)} ${String(w.localTeam ?? '-').padEnd(9)} ${String(self.appliedClass ?? '-').padEnd(8)} ${String(selfF).padStart(2)} ${String(selfD).padStart(2)} ${String(scores.get(localScoreId) ?? 0).padStart(5)} ${dumpHp(self.health, self.appliedClass).padStart(8)} ${String(shown === undefined ? '-' : Number(shown.toFixed(2))).padStart(5)} ${String(aliveSecs(localId, self.isDead, now) ?? '-').padStart(5)} ${' - '.padStart(4)} ${locoStr(localId).padEnd(13)} ${String(nm.getPing()).padStart(4)} ${String(nm.getTransportTier() ?? '-').padEnd(5)} ${ss ? `${ss.ha}/${ss.a}/${ss.s}/${ss.w}/${ss.st}/${ss.i}` : '-'}`;
}
function gameDump(): string[] {
  const d = depsRef;
  if (!d) {return ['  no world yet'];}
  const w = d.world;
  // Date.now, not performance.now - aliveSince is stamped by the
  // scoreboard path on the wall clock; mixing epochs prints garbage.
  const now = Date.now();
  const lines: string[] = [`  mode=${w.mode} map=${w.mapName ?? '-'} teams=${JSON.stringify(w.teamScores ?? {})}`];
  lines.push('  name                 team      cls      F  D  score   hp/max sheep alive rsv  loco(1/5/10/15s) ping net   asw(HA/A/S/W/ST/I)');
  lines.push(gameDumpSelfRow(d, w, now));
  for (const [id, rp] of w.remotePlayers) {lines.push(gameDumpRow(w, id, rp, now));}
  return lines;
}
// Module ref - the dump hooks are module-scope; deps flows in on tick.
let depsRef: RemotesDeps | undefined;
function noteDeps(d: RemotesDeps): void { if (!depsRef) {depsRef = d;} }
// Wire-roster snapshot for the game dump's ping/net columns - written
// per remote per tick, so it's the same data the scoreboard sees.
const wireRoster = new Map<string, { ping?: number | null; transport?: string | null; team?: string; health?: number }>();
function pruneAsw(live: Set<string>): void {
  for (const id of asw.keys()) {
    if (!live.has(id)) {asw.delete(id);}
  }
  for (const id of aswAltT.keys()) {
    if (!live.has(id)) {aswAltT.delete(id); aswAlt.delete(id);}
  }
  for (const id of wireRoster.keys()) {
    if (!live.has(id)) {wireRoster.delete(id);}
  }
}

/** Seconds alive, or null while dead. A first-seen-alive id stamps now -
 * join-time is the closest observable the client has for pre-existing
 * players. */
function aliveSecs(id: string, dead: boolean, now: number): number | null {
  if (dead) { aliveSince.delete(id); return null; }
  let at = aliveSince.get(id);
  if (at === undefined) { at = now; aliveSince.set(id, at); }
  return Math.floor((now - at) / 1000);
}

/** A leaver who quit alive never trips the death prune - evict ids the
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
  // Rows rebuild at ~4Hz, not per frame - a full roster Set+sort every
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
  const now = Date.now();
  const queriedIds = new Set<string>([localId]);
  // Self sorts into the ranking like everyone else - pinning the local
  // row to the top read as "unordered" whenever the leader wasn't you.
  const allRows = [
    selfScoreboardRow(deps, nm, localId, ffa, localScoreId, now),
    ...wireRosterRows(deps, nm, localId, ffa, now, queriedIds),
    ...offlineBotRows(deps, nm, ffa, now, queriedIds),
  ];
  const ranked = rankRows(deps.world.mode, allRows);
  pruneAliveSince(queriedIds);
  pruneAsw(queriedIds);
  hud.setScoreboardRows(ranked);
  hud.setScoreboardPingVisible?.(nm.isConnected()); // offline bots-only boards drop the latency column
  hud.setScoreboardNetVisible?.(nm.isConnected()); // and the transport column - every row would read 'bot'/'-'
  hud.setScoreboardTeamScores?.(deps.world.teamScores);
  const modTag = deps.world.instagib ? 'INSTAGIB' : deps.world.igun ? 'IGUNGAME' : deps.world.gungame ? 'GUNGAME' : undefined;
  hud.setScoreboardTitle(scoreboardTitle(deps.world.mode, deps.world.mapName, modTag));
}

// The local player's row - kill/death sums ride selfCount's two-key
// formula ('local' + the score id).
function selfScoreboardRow(deps: RemotesDeps, nm: NetworkManager, localId: string, ffa: Map<string, number>, localScoreId: string, now: number): SbRow {
  const self = deps.lazyPlayer();
  return { name: settings.get('fps-name') || localId, frags: selfCount(deps.world.killCounts, localScoreId), deaths: selfCount(deps.world.deathCounts, localScoreId), score: ffa.get(localScoreId) ?? null, ping: nm.serverPingMs == null ? nm.getPing() : `${nm.getPing()}/${Math.round(nm.serverPingMs)}`, net: nm.getTransportTier() ?? null, self: true, dead: self.isDead, team: deps.world.localTeam, sheep: deps.lazyPlayerSheep?.().shown ?? null, alive: aliveSecs(localId, self.isDead, now), cls: self.appliedClass, asw: aswStr(localId), loco: locoVals(localId) };
}

// net is string|null - 'bot' rows carry a label, not a transport tier.
function wireRosterRows(deps: RemotesDeps, nm: NetworkManager, localId: string, ffa: Map<string, number>, now: number, queriedIds: Set<string>): SbRow[] {
  return [...nm.getPlayers().keys()]
    .filter((id): boolean => id !== localId && isRemoteActive(deps, id, nm.getPlayers()))
    .map((id): SbRow => {
      queriedIds.add(id);
      return wireRow(deps, id, nm.getPlayers().get(id), ffa, now);
    });
}

function wireRow(deps: RemotesDeps, id: string, ps: RemotePlayerState | undefined, ffa: Map<string, number>, now: number): SbRow {
  const bot = isBotId(id);
  const dead = ps?.isDead ?? false;
  const name = bot ? botRosterName(id) : (ps?.name ?? id);
  const net = bot ? 'bot' : (ps?.transport ?? null);
  return { name, frags: or0(deps.world.killCounts.get(id)), deaths: or0(deps.world.deathCounts.get(id)), score: orN(ffa.get(id)), ping: orN(ps?.ping), net, self: false, dead, team: ps?.team, sheep: orN(ps?.sheep), bot, alive: aliveSecs(id, dead, now), cls: ps?.armorClass, asw: aswStr(id), loco: locoVals(id) };
}

const or0 = (v: number | undefined): number => v ?? 0;
const orN = <T>(v: T | undefined): T | null => v ?? null;

// Offline bots live in world.remotePlayers, not the network roster -
// they'd be invisible on the scoreboard otherwise.
function offlineBotRows(deps: RemotesDeps, nm: NetworkManager, ffa: Map<string, number>, now: number, queriedIds: Set<string>): SbRow[] {
  const out: SbRow[] = [];
  for (const [id, rp] of deps.world.remotePlayers) {
    if (nm.getPlayers().has(id)) {continue;}
    queriedIds.add(id);
    // GameBot carries a team field; FFA bots get a self-id pseudo-team,
    // which must not count as a real team row.
    const t = (rp as { team?: string }).team;
    const team = t === 'alpha' || t === 'bravo' ? t : undefined;
    const sheep = (rp as { sheepShown?: number; sheep?: number }).sheepShown ?? (rp as { sheep?: number }).sheep ?? null;
    out.push({ name: botRosterName(id), frags: or0(deps.world.killCounts.get(id)), deaths: or0(deps.world.deathCounts.get(id)), score: orN(ffa.get(id)), ping: null, net: 'bot', self: false, dead: rp.isDead, team, sheep, bot: isBotId(id), alive: aliveSecs(id, rp.isDead, now), cls: rp.armorClass, asw: aswStr(id), loco: locoVals(id) });
  }
  return out;
}

export interface RemotesApi {
  networkTick: (dt: number) => void;
  updateScoreboard: () => void;
  getLastSentPos: () => { x: number; y: number; z: number };
  setLastSentPos: (pos: { x: number; y: number; z: number }) => void;
}

export function createRemotes(deps: RemotesDeps): RemotesApi {
  noteDeps(deps); // the game-dump hook needs deps even offline
  const lastSentPos = { x: 0, y: 0, z: 0 };
  let lastRemotePosLog = '';
  const lastTintOf = new Map<string, string>();
  let rosterPollT = 0;
  let wasConnected = true;

  deps.world.remotePlayers.hooks = makeRemoteHooks(deps);
  // Tint memory keys on ids - same leaver-leak class as aliveSince.
  const prevOnRemove = deps.world.remotePlayers.hooks.onRemove;
  deps.world.remotePlayers.hooks.onRemove = (id, ent, reason): void => {
    lastTintOf.delete(id);
    prevOnRemove?.(id, ent, reason);
  };

  function getLastSentPos(): { x: number; y: number; z: number; } { return lastSentPos; }
  function setLastSentPos(pos: { x: number; y: number; z: number }): void {
    lastSentPos.x = pos.x; lastSentPos.y = pos.y; lastSentPos.z = pos.z;
  }


  // Self-position bookkeeping before the send: wire-history journal, the
  // lastSentPos snapshot, and the declared-teleport edge. Declared
  // teleport (warp/respawn): precede the position stream so the server
  // anchors its plausibility check at the NEW spot.
  function selfPosPreflight(nm: NetworkManager, player: Player): void {
    lastSentPos.x = player.pos.x;
    lastSentPos.y = player.pos.y;
    lastSentPos.z = player.pos.z;
    const hist = deps.world.localPosHistory;
    hist.push({ t: performance.now(), x: player.pos.x, y: player.pos.y, z: player.pos.z, vx: player.vel.x, vy: player.vel.y, vz: player.vel.z });
    if (hist.length > 180) {hist.shift();}
    if (player.pendingTeleport) {
      player.pendingTeleport = false;
      nm.sendTeleport(
        { x: player.pos.x, y: player.pos.y, z: player.pos.z },
        { yaw: player.yaw, pitch: player.pitch },
        { x: player.vel.x, y: player.vel.y, z: player.vel.z },
      );
    }
  }

  // Network per-frame work: send position, tick remote players, prune stale ones
  function networkTick(dt: number): void {
    const nm = deps.lazyNetworkManager();
    const player = deps.lazyPlayer();
    // Demo playback drives player.pos from recorded frames - sending them
    // would look like teleport spam to the server, and live remote ticks
    // would mix the real match into the replay scene.
    if (deps.world.playbackMode) {
      player.pendingTeleport = false; // don't queue a stale teleport for later
      // Playback feeds flagMarkers/nodeMarkers from the demo stream -
      // the projection ticks must still run or the HUD diamonds die.
      tickFlagMarkers(deps, nm.getLocalPlayerId(), player.pos, deps.lazyHud(), deps.lazyCamera());
      tickNodeMarkers(deps, deps.lazyHud(), deps.lazyCamera());
      return;
    }
    selfPosPreflight(nm, player);
    nm.sendPosition(
      { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      { yaw: player.yaw, pitch: player.pitch },
      { x: player.vel.x, y: player.vel.y, z: player.vel.z }
    );

    // Connected → disconnected: the wire map is already cleared, so the
    // prune below reaps the entities - but indicator ids that aren't
    // entity-keyed (flag:alpha/bravo) have no owner to clean them.
    // Sweep the whole overlay once on the transition or they freeze
    // mid-screen for the life of the session.
    if (wasConnected && !nm.isConnected()) {deps.lazyHud().clearPlayerIndicators();}
    wasConnected = nm.isConnected();

    const players = nm.getPlayers();
    const previousRemoteCount = deps.world.remotePlayers.size;

    const localPlayerId = nm.getLocalPlayerId();
    // pos.y is the eye - feet sit eyeHeight below (same convention the
    // remote feetY getter uses). onGround stays the sim's word for the
    // locomotion FX; the asw column wants clearance, not the flag.
    const selfAlt = aswAltFor(localPlayerId, player.pos.x, player.pos.z, player.pos.y - CLASS_STATS[player.appliedClass].eyeHeight, deps.lazyTerrain(), dt);
    aswAccrue(localPlayerId, player.isDead, selfAlt, player.skiing, dt, player.vel.length());
    locoNote(localPlayerId, player.isDead, player.pos.x, player.pos.z);

    // Roster work - player list UI + join/leave log - is polled at 2Hz.
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
    // 10Hz ghost-epoch sampler - rendered/wire/ghost divergence audit.
    sampleRemoteGhosts(deps.world.remotePlayers.values());
    const hud = deps.lazyHud();
    const cam = deps.lazyCamera();
    tickOnScreen(deps, cam);
    // Local bots ('bot:', 'dummy') aren't in the network roster, so the
    // forEach above never touches them - same red marker as real remotes.
    for (const [id, rp] of deps.world.remotePlayers) {
      if (players.has(id)) {continue;}
      const gb = rp as { grounded?: boolean; wireSki?: boolean };
      if (rp.isDead) {
        hud.removePlayerIndicator(id);
      } else {
        // Local bots aren't network remotes - they used to jet silently and
        // leave NO ski dust at all. Same shared pass, so a bot's trail reads
        // exactly like a human's.
        emitLocomotionFx(deps.lazyEffects(), rp.position, rp.vel, gb.grounded ?? true, Boolean(gb.wireSki), isJetting(rp, false));
        // GameBot carries `team` ('alpha'/'bravo', own id in FFA) - plain
        // RemotePlayers have none and stay enemy red.
        const friendly = (rp as { team?: string }).team === deps.world.localTeam
          && (rp as { team?: string }).team !== undefined;
        _markPos.copy(rp.position); _markPos.y += rp.renderLift;
        const held = (rp as { heldTokens?: number }).heldTokens ?? 0;
        rp.setHeld(held);
        hud.updatePlayerIndicator(id, _markPos, cam, { friendly, sheep: (rp as { sheepShown?: number; sheep?: number }).sheepShown ?? (rp as { sheep?: number }).sheep, bot: isBotId(id), cls: rp.armorClass, hp: (rp as { botHp?: number }).botHp, held });
      }
      aswAccrue(id, rp.isDead, aswAltFor(id, rp.position.x, rp.position.z, rp.feetY, deps.lazyTerrain(), dt), gb.wireSki ?? false, dt, rp.vel.length());
      locoNote(id, rp.isDead, rp.position.x, rp.position.z);
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
