import { reconstructSeek, applyPlaybackEvents, releasePlaybackBeam, type PlaybackWorld } from '../demo/playbackReconstruction.js';
import type { ProjectileEvent, TargetEvent } from '../demo/types.js';
import { RemoteFrameFlags } from '../demo/types.js';
import type { RemoteSample } from '../demo/DemoRecorder.js';
import type { DemoManager } from '../demo/index.js';
import type { Ball } from '../entities/balls.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';
import type { Player } from '../entities/Player.js';
import { noteLocalSnap } from './gameLoop.js';
import type { Projectile } from '../projectiles/Projectile.js';
import type { Terrain } from '../world/terrain.js';
import type * as THREE from 'three';
import { ChildLogger } from '../core/Logger.js';
import type { WorldState } from './worldState.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { SLOT_DEFS } from '../weapons.js';
import { ProjectileEventType } from '../demo/types.js';
import { updatePlaybackCreatures, clearPlaybackCreatures, type PlaybackCreature } from '../demo/playbackCreatures.js';
import { clearPlaybackDeployables, type PlaybackDeployable } from '../demo/playbackDeployables.js';
import { clearPlaybackMarkers, updatePlaybackFlags } from '../demo/playbackMarkers.js';

const logger = new ChildLogger('DemoPlayback');

export interface DemoLifecycleDeps {
  lazyScene: () => THREE.Scene;
  lazyTerrain: () => Terrain;
  lazyCamera: () => THREE.PerspectiveCamera;
  lazyPlayer: () => Player;
  lazyDemoManager: () => DemoManager | null;
  lazyViewModel: () => import('../entities/ViewModel.js').ViewModel | null;
  damageNumberManager: () => DamageNumberManager;
  fragMessages: () => FragMessages;
  lazyHud: () => HUD;
  balls: Ball[];
  targets: import('../entities/balls.js').Targetable[]; // balls+crawlers live here too — keep in sync on removal
  crawlers: import('../entities/Crawler.js').Crawler[];
  turrets: import('../entities/Turretter.js').Turretter[];
  rollers: import('../entities/Roller.js').Roller[];
  seekers: import('../entities/Seeker.js').Seeker[];
  overlords: import('../entities/Overlord.js').Overlord[];
  mines: import('../entities/Mine.js').Mine[];
  totems: import('../entities/Totem.js').Totem[];
  rakks: import('../entities/Rakk.js').Rakk[];
  world: WorldState;
  overlay: HTMLElement;
  rendererCanvas: HTMLCanvasElement;
}

interface DemoLifecycleCtx extends DemoLifecycleDeps {
  playbackWorld: PlaybackWorld;
  playbackProjectiles: Projectile[];
  playbackProjectileById: Map<number, Projectile>;
  playbackBallById: Map<number, Ball>;
  playbackProjectileOrigin: Map<number, THREE.Vector3>;
  playbackRemotes: Map<number, RemotePlayer>;
  frozenWarn: { n: number };
  seekReconstructing: { on: boolean };
  /** wid currently mirrored onto the viewmodel — -1 means "not applied yet". */
  playbackWid: number;
}

// Frame weaponType → viewmodel wid. Any weaponType the current build doesn't
// know (deleted since the clip was recorded) shows the stock rocket launcher
// rather than breaking playback.
function widForWeaponType(wt: number): number {
  const i = SLOT_DEFS.findIndex(d => d.weaponType === wt);
  return i !== -1 ? i : 0;
}

function updatePlaybackProjectiles(d: DemoLifecycleCtx, dt: number): void {
  // Fade playback rail beams — pooled alongside the projectiles that spawn them.
  for (let i = d.playbackWorld.beams.length - 1; i >= 0; i--) {
    const b = d.playbackWorld.beams[i];
    b.life -= dt;
    if (b.life <= 0) {
      d.lazyScene().remove(b.mesh);
      releasePlaybackBeam(d.playbackWorld, b);
      d.playbackWorld.beams.splice(i, 1);
    } else {
      b.mat.opacity = 0.85 * (b.life / b.maxLife);
    }
  }
  for (let i = d.playbackProjectiles.length - 1; i >= 0; i--) {
    const r = d.playbackProjectiles[i];
    r.update(dt, d.lazyTerrain());
    if (r.dead) {
      r.dispose();
      d.playbackProjectiles.splice(i, 1);
      for (const [id, proj] of d.playbackProjectileById) {
        if (proj === r) {
          d.playbackProjectileById.delete(id);
          break;
        }
      }
    }
  }
}

// During playback: only update playback balls, skip live game balls and spawning
function updateBallsPlayback(d: DemoLifecycleCtx, dt: number): void {
  const terrain = d.lazyTerrain();
  const player = d.lazyPlayer();
  let frozenCount = 0;
  for (let i = d.balls.length - 1; i >= 0; i--) {
    const b = d.balls[i];
    if (d.playbackBallById.has(b.id)) {
      b.update(dt, terrain, player.pos);
      // Detect frozen balls (near-zero velocity, not dead, not on ground resting)
      if (!b.dead && b.vel.lengthSq() < 0.01) {
        frozenCount++;
      }
    }
    if (b.disposed) {
      d.balls.splice(i, 1);
      const ti = d.targets.indexOf(b);
      if (ti !== -1) {d.targets.splice(ti, 1);}
      d.playbackBallById.delete(b.id);
    }
  }
  if (frozenCount > 0) {
    d.frozenWarn.n++;
    if (d.frozenWarn.n <= 5 || d.frozenWarn.n % 60 === 0) {
      logger.debug(`${frozenCount} ball(s) frozen midair (vel~0). Total playback balls: ${d.playbackBallById.size}`);
    }
  } else {
    d.frozenWarn.n = 0;
  }
  updatePlaybackCreatures(d.playbackWorld, dt);
  updatePlaybackFlags(d.playbackWorld);
}

// Shared cleanup: dispose live + playback transient objects
function clearTransientObjects(d: DemoLifecycleCtx): void {
  for (const rp of d.playbackRemotes.values()) {rp.dispose();}
  d.playbackRemotes.clear();
  for (const r of d.playbackProjectiles) {r.dispose();}
  d.playbackProjectiles.length = 0;
  d.playbackProjectileById.clear();
  d.playbackProjectileOrigin.clear();
  for (const ball of d.playbackBallById.values()) {
    ball.dispose();
    const idx = d.balls.indexOf(ball);
    if (idx !== -1) {d.balls.splice(idx, 1);}
    const ti = d.targets.indexOf(ball);
    if (ti !== -1) {d.targets.splice(ti, 1);}
  }
  d.playbackBallById.clear();
  clearPlaybackCreatures(d.playbackWorld);
  clearPlaybackDeployables(d.playbackWorld);
  clearPlaybackMarkers(d.playbackWorld);
  for (const e of d.world.debrisList) {e.dispose();}
  d.world.debrisList.length = 0;
  for (const e of d.world.explosions) {e.dispose();}
  d.world.explosions.length = 0;
  for (const i of d.world.implosions) {i.dispose();}
  d.world.implosions.length = 0;
  for (const g of d.world.aoeGizmos) {g.dispose();}
  d.world.aoeGizmos.length = 0;
  for (const dd of d.world.playerDebrisList) {dd.dispose();}
  d.world.playerDebrisList.length = 0;
  for (const b of d.playbackWorld.beams) {
    d.lazyScene().remove(b.mesh);
    releasePlaybackBeam(d.playbackWorld, b);
  }
  d.playbackWorld.beams.length = 0;
}

// Snapshot existing alive balls into the demo recording — needed when recording
// starts after balls are already in the scene (they have no Spawned event yet).
function snapshotExistingBallsForRecording(d: DemoLifecycleCtx, onBallRecorded?: (ball: Ball) => void): void {
  const dm = d.lazyDemoManager();
  if (!dm?.isRecording) {return;}
  for (const ball of d.balls) {
    if (ball.dead) {continue;}
    dm.recordTargetSpawned(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);
    onBallRecorded?.(ball);
  }
}

function wireDemoHandlers(d: DemoLifecycleCtx, demoManager: DemoManager, onPlaybackStop: () => void): void {
  // Handle projectile events from demo playback: spawn projectiles on Fired, explode on Destroyed
  demoManager.onPlaybackEvent = (events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }) => {
    if (d.seekReconstructing.on) {
      reconstructSeek(d.playbackWorld, events, demoManager.currentTime);
      d.seekReconstructing.on = false;
      return;
    }
    // Muzzle kick rides the same Fired events that spawn the projectiles —
    // the recorded weapon in frame and the shot stay in sync because they
    // share one timestamp stream.
    const vm = d.lazyViewModel();
    if (vm) {
      for (const e of events.projectiles) {
        if (e.eventType === ProjectileEventType.Fired) {vm.kick();}
      }
    }
    applyPlaybackEvents(d.playbackWorld, events);
  };
  demoManager.onPlaybackState = (state) => {
    if (demoManager.isPlaying) {
      const player = d.lazyPlayer();
      player.pos.set(state.posX, state.posY, state.posZ);
      noteLocalSnap(); // replayed trajectory isn't a physics snap — scrubbing included
      player.vel.set(state.velX, state.velY, state.velZ);
      player.yaw = state.yaw;
      player.pitch = state.pitch;
      // Mirror the recorded held weapon onto the viewmodel. Unknown ids
      // (a weapon deleted since recording) show the stock launcher.
      const vm = d.lazyViewModel();
      if (vm) {
        const wid = widForWeaponType(state.weaponType);
        if (wid !== d.playbackWid) { d.playbackWid = wid; vm.switchWeapon(wid); }
      }
    }
  };

  // Demo playback ends — just pause, keep objects visible (frozen)
  demoManager.onPlaybackEnd = () => {
    // No cleanup — objects stay visible as if user pressed pause.
    // Cleanup happens when user explicitly stops playback via ESC.
  };

  // User explicitly stops playback (ESC, UI stop button) — full cleanup
  demoManager.onPlaybackStop = () => {
    d.world.playbackMode = false;
    // Re-arm so the next replay re-applies its own weapon instead of
    // inheriting whatever the previous clip left selected.
    d.playbackWid = -1;
    for (const rp of d.world.remotePlayers.values()) {rp.setStaleHidden(false);}
    clearTransientObjects(d);
    // Show overlay menu so user can replay or pick another clip
    if (document.pointerLockElement === d.rendererCanvas) {
      document.exitPointerLock();
    }
    d.overlay.style.display = 'flex';
    document.body.classList.add('menu-open'); // hides the HUD layer — same as overlayInput.setOverlay
    demoManager.fetchCoolShotsFromServer();
    // Resume recording for new cool shots
    demoManager.startRecording();
    onPlaybackStop();
  };

  // Clear live game objects when playback starts so they don't hang frozen in the scene
  demoManager.onPlaybackStart = () => {
    // The replay is its own world — the live wire must not fight it
    d.world.playbackMode = true;
    // Cool-shot clicks come from the overlay menu — a replay behind an
    // open menu is invisible. Close it and grab pointer lock (the click
    // is a user gesture, so the request is legal).
    d.overlay.style.display = 'none';
    document.body.classList.remove('menu-open');
    d.rendererCanvas.requestPointerLock();
    // Live remote players would otherwise stand ghosted inside the replay
    for (const rp of d.world.remotePlayers.values()) {rp.setStaleHidden(true);}
    // Dispose all non-playback balls (live game balls)
    const playbackBallSet = new Set(d.playbackBallById.values());
    for (let i = d.balls.length - 1; i >= 0; i--) {
      const b = d.balls[i];
      if (!playbackBallSet.has(b)) {
        b.dispose();
        d.balls.splice(i, 1);
        const ti = d.targets.indexOf(b);
        if (ti !== -1) {d.targets.splice(ti, 1);}
      }
    }
    // Clear live projectiles
    for (const r of d.world.projectiles) {r.dispose();}
    d.world.projectiles.length = 0;
    // All live species are game objects too — dispose so they don't hang
    // frozen in the scene during playback
    for (const m of d.mines) {m.onDetonate = undefined;} // teardown isn't a detonation
    type DisposableTarget = import('../entities/balls.js').Targetable & { dispose(): void };
    for (const list of [d.crawlers, d.turrets, d.rollers, d.seekers, d.overlords, d.mines, d.totems, d.rakks] as DisposableTarget[][]) {
      for (const e of list) {
        e.dispose();
        const ti = d.targets.indexOf(e);
        if (ti !== -1) {d.targets.splice(ti, 1);}
      }
      list.length = 0;
    }
    clearTransientObjects(d);
  };

  // Clear playback projectiles on seek so they don't get orphaned
  demoManager.onPlaybackSeek = () => {
    d.seekReconstructing.on = true;
    clearTransientObjects(d);
  };

  // Recorded remote players — states arrive already interpolated at demo
  // time; RemotePlayer's own snapshot buffer gets them as live updates,
  // so replica smoothing is literally the production netcode path.
  demoManager.onRemotePlayback = (states, dt) => {
    const roster = demoManager.getRoster();
    const seen = new Set<number>();
    for (const s of states) {
      seen.add(s.rosterIdx);
      let rp = d.playbackRemotes.get(s.rosterIdx);
      const pos = { x: s.posX, y: s.posY, z: s.posZ };
      if (!rp) {
        rp = new RemotePlayer(d.lazyScene(), roster[s.rosterIdx] ?? `remote${s.rosterIdx}`, pos, d.lazyTerrain());
        d.playbackRemotes.set(s.rosterIdx, rp);
      }
      rp.update(pos, { yaw: s.yaw, pitch: s.pitch }, dt, 0, { x: s.velX, y: s.velY, z: s.velZ });
      rp.tick(dt, d.lazyCamera().position);
      rp.setStaleHidden((s.flags & RemoteFrameFlags.Dead) !== 0);
    }
    // Roster players absent at this time keep their replica but hidden —
    // e.g. they joined after the seek target or hadn't spawned yet.
    for (const [idx, rp] of d.playbackRemotes) {
      if (!seen.has(idx)) {rp.setStaleHidden(true);}
    }
  };

  // Recording source: every remote player the world knows about. Bot
  // entries ('bot:'-prefixed) ride along too — they're in the same map.
  // The sample buffer + objects are reused between calls — the recorder
  // consumes them synchronously, and ~160 allocs/s of throwaway structs
  // was the recorder's last GC churn.
  const remoteSampleBuf: RemoteSample[] = [];
  demoManager.setRemoteSource(() => {
    const out = remoteSampleBuf;
    let i = 0;
    for (const [id, rp] of d.world.remotePlayers) {
      let s = out[i];
      if (!s) {
        s = { id: '', posX: 0, posY: 0, posZ: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0, dead: false, ski: false };
        out[i] = s;
      }
      s.id = id;
      s.posX = rp.position.x; s.posY = rp.position.y; s.posZ = rp.position.z;
      s.velX = rp.vel.x; s.velY = rp.vel.y; s.velZ = rp.vel.z;
      s.yaw = rp.rotation.yaw; s.pitch = rp.rotation.pitch;
      s.dead = rp.isDead; s.ski = false;
      i++;
    }
    out.length = i;
    return out;
  });
}

// Demo playback lifecycle: owns the playback projectile/ball registries and
// wires all onPlayback* handlers (events, state, start/stop/seek/end).
export function createDemoLifecycle(deps: DemoLifecycleDeps) {
  const playbackProjectiles: Projectile[] = [];
  const playbackProjectileById = new Map<number, Projectile>();
  const playbackBallById = new Map<number, Ball>();
  const playbackCreatureById = new Map<number, PlaybackCreature>();
  const playbackDeployableById = new Map<number, PlaybackDeployable>();
  const playbackFlags = new Map<number, THREE.Group>();
  const playbackPickups = new Map<number, { dispose(scene: THREE.Scene): void }>();
  const playbackRemotesMap = new Map<number, RemotePlayer>();
  const playbackProjectileOrigin = new Map<number, THREE.Vector3>();

  const playbackWorld: PlaybackWorld = {
    get scene() { return deps.lazyScene(); },
    get terrain() { return deps.lazyTerrain(); },
    get camera() { return deps.lazyCamera(); },
    getPlayer: () => deps.lazyPlayer(),
    balls: deps.balls,
    debrisList: deps.world.debrisList,
    explosions: deps.world.explosions,
    implosions: deps.world.implosions,
    playbackBallById,
    playbackCreatureById,
    playbackDeployableById,
    playbackFlags,
    playbackPickups,
    remotePosAt: (rosterIdx) => playbackRemotesMap.get(rosterIdx)?.position ?? null,
    playbackProjectiles,
    playbackProjectileById,
    playbackProjectileOrigin,
    beams: [],
    beamPool: [],
    get damageNumberManager() { return deps.damageNumberManager(); },
    get fragMessages() { return deps.fragMessages(); },
    get hud() { return deps.lazyHud(); },
  };

  const d: DemoLifecycleCtx = Object.assign(deps, {
    playbackProjectiles,
    playbackProjectileById,
    playbackBallById,
    playbackProjectileOrigin,
    // Recorded remote players replayed as real RemotePlayer replicas — their
    // snapshot buffer smooths the 20Hz samples exactly like live net code.
    playbackRemotes: playbackRemotesMap,
    frozenWarn: { n: 0 },
    seekReconstructing: { on: false },
    playbackWid: -1,
    playbackWorld,
  });

  return {
    playbackWorld,
    playbackBallById,
    updatePlaybackProjectiles: (dt: number) => updatePlaybackProjectiles(d, dt),
    updateBallsPlayback: (dt: number) => updateBallsPlayback(d, dt),
    snapshotExistingBallsForRecording: (cb?: (ball: Ball) => void) => snapshotExistingBallsForRecording(d, cb),
    wireDemoHandlers: (dm: DemoManager, onStop: () => void) => wireDemoHandlers(d, dm, onStop),
  };
}
