import { reconstructSeek, applyPlaybackEvents, type PlaybackWorld } from '../demo/playbackReconstruction.js';
import type { ProjectileEvent, TargetEvent } from '../demo/types.js';
import { RemoteFrameFlags } from '../demo/types.js';
import type { RemoteSample } from '../demo/DemoRecorder.js';
import type { DemoManager } from '../demo/index.js';
import type { Ball } from '../entities/balls.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';
import type { Player } from '../entities/Player.js';
import type { Projectile } from '../projectiles/Projectile.js';
import type { Terrain } from '../world/terrain.js';
import * as THREE from 'three';
import { ChildLogger } from '../core/Logger.js';
import type { WorldState } from './worldState.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';

const logger = new ChildLogger('DemoPlayback');

export interface DemoLifecycleDeps {
  lazyScene: () => THREE.Scene;
  lazyTerrain: () => Terrain;
  lazyCamera: () => THREE.PerspectiveCamera;
  lazyPlayer: () => Player;
  lazyDemoManager: () => DemoManager | null;
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

// Demo playback lifecycle: owns the playback projectile/ball registries and
// wires all onPlayback* handlers (events, state, start/stop/seek/end).
export function createDemoLifecycle(deps: DemoLifecycleDeps) {
  // ---- Playback projectile reconstruction registries ----
  const playbackProjectiles: Projectile[] = [];
  const playbackProjectileById = new Map<number, Projectile>();
  const playbackBallById = new Map<number, Ball>();
  const playbackProjectileOrigin = new Map<number, THREE.Vector3>();
  // Recorded remote players replayed as real RemotePlayer replicas — their
  // snapshot buffer smooths the 20Hz samples exactly like live net code.
  const playbackRemotes = new Map<number, RemotePlayer>();
  let playbackFrozenWarnCounter = 0;
  let seekReconstructing = false;

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
    playbackProjectiles,
    playbackProjectileById,
    playbackProjectileOrigin,
    beams: [],
    beamPool: [],
    get damageNumberManager() { return deps.damageNumberManager(); },
    get fragMessages() { return deps.fragMessages(); },
    get hud() { return deps.lazyHud(); },
  };

  function updatePlaybackProjectiles(dt: number): void {
    // Fade playback rail beams — pooled alongside the projectiles that spawn them.
    for (let i = playbackWorld.beams.length - 1; i >= 0; i--) {
      const b = playbackWorld.beams[i];
      b.life -= dt;
      if (b.life <= 0) {
        deps.lazyScene().remove(b.mesh);
        playbackWorld.beamPool.push(b);
        playbackWorld.beams.splice(i, 1);
      } else {
        b.mat.opacity = 0.85 * (b.life / b.maxLife);
      }
    }
    for (let i = playbackProjectiles.length - 1; i >= 0; i--) {
      const r = playbackProjectiles[i];
      r.update(dt, deps.lazyTerrain());
      if (r.dead) {
        r.dispose();
        playbackProjectiles.splice(i, 1);
        for (const [id, proj] of playbackProjectileById) {
          if (proj === r) {
            playbackProjectileById.delete(id);
            break;
          }
        }
      }
    }
  }

  // During playback: only update playback balls, skip live game balls and spawning
  function updateBallsPlayback(dt: number): void {
    const terrain = deps.lazyTerrain();
    const player = deps.lazyPlayer();
    let frozenCount = 0;
    for (let i = deps.balls.length - 1; i >= 0; i--) {
      const b = deps.balls[i];
      if (playbackBallById.has(b.id)) {
        b.update(dt, terrain, player.pos);
        // Detect frozen balls (near-zero velocity, not dead, not on ground resting)
        if (!b.dead && b.vel.lengthSq() < 0.01) {
          frozenCount++;
        }
      }
      if (b.disposed) {
        deps.balls.splice(i, 1);
        const ti = deps.targets.indexOf(b);
        if (ti >= 0) deps.targets.splice(ti, 1);
      }
    }
    if (frozenCount > 0) {
      playbackFrozenWarnCounter++;
      if (playbackFrozenWarnCounter <= 5 || playbackFrozenWarnCounter % 60 === 0) {
        logger.debug(`${frozenCount} ball(s) frozen midair (vel~0). Total playback balls: ${playbackBallById.size}`);
      }
    } else {
      playbackFrozenWarnCounter = 0;
    }
  }

  // Shared cleanup: dispose live + playback transient objects
  function clearTransientObjects(): void {
    for (const rp of playbackRemotes.values()) rp.dispose();
    playbackRemotes.clear();
    for (const r of playbackProjectiles) r.dispose();
    playbackProjectiles.length = 0;
    playbackProjectileById.clear();
    playbackProjectileOrigin.clear();
    for (const ball of playbackBallById.values()) {
      ball.dispose();
      const idx = deps.balls.indexOf(ball);
      if (idx >= 0) deps.balls.splice(idx, 1);
      const ti = deps.targets.indexOf(ball);
      if (ti >= 0) deps.targets.splice(ti, 1);
    }
    playbackBallById.clear();
    for (const d of deps.world.debrisList) d.dispose();
    deps.world.debrisList.length = 0;
    for (const e of deps.world.explosions) e.dispose();
    deps.world.explosions.length = 0;
    for (const i of deps.world.implosions) i.dispose();
    deps.world.implosions.length = 0;
    for (const g of deps.world.aoeGizmos) g.dispose();
    deps.world.aoeGizmos.length = 0;
    for (const d of deps.world.playerDebrisList) d.dispose();
    deps.world.playerDebrisList.length = 0;
    for (const b of playbackWorld.beams) deps.lazyScene().remove(b.mesh);
    playbackWorld.beamPool.push(...playbackWorld.beams);
    playbackWorld.beams.length = 0;
  }

  // Snapshot existing alive balls into the demo recording — needed when recording
  // starts after balls are already in the scene (they have no Spawned event yet).
  function snapshotExistingBallsForRecording(onBallRecorded?: (ball: Ball) => void): void {
    const dm = deps.lazyDemoManager();
    if (!dm?.isRecording) return;
    for (const ball of deps.balls) {
      if (ball.dead) continue;
      dm.recordTargetSpawned(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);
      onBallRecorded?.(ball);
    }
  }

  function wireDemoHandlers(demoManager: DemoManager, onPlaybackStop: () => void): void {
    // Handle projectile events from demo playback: spawn projectiles on Fired, explode on Destroyed
    demoManager.onPlaybackEvent = (events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }) => {
      if (seekReconstructing) {
        reconstructSeek(playbackWorld, events, demoManager.currentTime);
        seekReconstructing = false;
        return;
      }
      applyPlaybackEvents(playbackWorld, events);
    };
    demoManager.onPlaybackState = (state) => {
      if (demoManager.isPlaying) {
        const player = deps.lazyPlayer();
        player.pos.set(state.posX, state.posY, state.posZ);
        player.vel.set(state.velX, state.velY, state.velZ);
        player.yaw = state.yaw;
        player.pitch = state.pitch;
      }
    };

    // Demo playback ends — just pause, keep objects visible (frozen)
    demoManager.onPlaybackEnd = () => {
      // No cleanup — objects stay visible as if user pressed pause.
      // Cleanup happens when user explicitly stops playback via ESC.
    };

    // User explicitly stops playback (ESC, UI stop button) — full cleanup
    demoManager.onPlaybackStop = () => {
      deps.world.playbackMode = false;
      for (const rp of deps.world.remotePlayers.values()) rp.setStaleHidden(false);
      clearTransientObjects();
      // Show overlay menu so user can replay or pick another clip
      if (document.pointerLockElement === deps.rendererCanvas) {
        document.exitPointerLock();
      }
      deps.overlay.style.display = 'flex';
      document.body.classList.add('menu-open'); // hides the HUD layer — same as overlayInput.setOverlay
      demoManager.fetchCoolShotsFromServer();
      // Resume recording for new cool shots
      demoManager.startRecording();
      onPlaybackStop();
    };

    // Clear live game objects when playback starts so they don't hang frozen in the scene
    demoManager.onPlaybackStart = () => {
      // The replay is its own world — the live wire must not fight it
      deps.world.playbackMode = true;
      // Cool-shot clicks come from the overlay menu — a replay behind an
      // open menu is invisible. Close it and grab pointer lock (the click
      // is a user gesture, so the request is legal).
      deps.overlay.style.display = 'none';
      document.body.classList.remove('menu-open');
      deps.rendererCanvas.requestPointerLock();
      // Live remote players would otherwise stand ghosted inside the replay
      for (const rp of deps.world.remotePlayers.values()) rp.setStaleHidden(true);
      // Dispose all non-playback balls (live game balls)
      const playbackBallSet = new Set(playbackBallById.values());
      for (let i = deps.balls.length - 1; i >= 0; i--) {
        const b = deps.balls[i];
        if (!playbackBallSet.has(b)) {
          b.dispose();
          deps.balls.splice(i, 1);
          const ti = deps.targets.indexOf(b);
          if (ti >= 0) deps.targets.splice(ti, 1);
        }
      }
      // Clear live projectiles
      for (const r of deps.world.projectiles) r.dispose();
      deps.world.projectiles.length = 0;
      // All live species are game objects too — dispose so they don't hang
      // frozen in the scene during playback
      for (const m of deps.mines) m.onDetonate = undefined; // teardown isn't a detonation
      type DisposableTarget = import('../entities/balls.js').Targetable & { dispose(): void };
      for (const list of [deps.crawlers, deps.turrets, deps.rollers, deps.seekers, deps.overlords, deps.mines, deps.totems, deps.rakks] as DisposableTarget[][]) {
        for (const e of list) {
          e.dispose();
          const ti = deps.targets.indexOf(e);
          if (ti >= 0) deps.targets.splice(ti, 1);
        }
        list.length = 0;
      }
      clearTransientObjects();
    };

    // Clear playback projectiles on seek so they don't get orphaned
    demoManager.onPlaybackSeek = () => {
      seekReconstructing = true;
      clearTransientObjects();
    };

    // Recorded remote players — states arrive already interpolated at demo
    // time; RemotePlayer's own snapshot buffer gets them as live updates,
    // so replica smoothing is literally the production netcode path.
    demoManager.onRemotePlayback = (states, dt) => {
      const roster = demoManager.getRoster();
      const seen = new Set<number>();
      for (const s of states) {
        seen.add(s.rosterIdx);
        let rp = playbackRemotes.get(s.rosterIdx);
        const pos = { x: s.posX, y: s.posY, z: s.posZ };
        if (!rp) {
          rp = new RemotePlayer(deps.lazyScene(), roster[s.rosterIdx] ?? `remote${s.rosterIdx}`, pos, deps.lazyTerrain());
          playbackRemotes.set(s.rosterIdx, rp);
        }
        rp.update(pos, { yaw: s.yaw, pitch: s.pitch }, dt, 0, { x: s.velX, y: s.velY, z: s.velZ });
        rp.tick(dt);
        rp.setStaleHidden((s.flags & RemoteFrameFlags.Dead) !== 0);
      }
      // Roster players absent at this time keep their replica but hidden —
      // e.g. they joined after the seek target or hadn't spawned yet.
      for (const [idx, rp] of playbackRemotes) {
        if (!seen.has(idx)) rp.setStaleHidden(true);
      }
    };

    // Recording source: every remote player the world knows about. Bot
    // entries ('bot:'-prefixed) ride along too — they're in the same map.
    demoManager.setRemoteSource(() => {
      const out: RemoteSample[] = [];
      for (const [id, rp] of deps.world.remotePlayers) {
        out.push({
          id,
          posX: rp.position.x, posY: rp.position.y, posZ: rp.position.z,
          velX: rp.vel.x, velY: rp.vel.y, velZ: rp.vel.z,
          yaw: rp.rotation.yaw, pitch: rp.rotation.pitch,
          dead: rp.isDead, ski: false,
        });
      }
      return out;
    });
  }

  return {
    playbackWorld,
    playbackBallById,
    updatePlaybackProjectiles,
    updateBallsPlayback,
    snapshotExistingBallsForRecording,
    wireDemoHandlers,
  };
}
