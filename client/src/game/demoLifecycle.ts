import { reconstructSeek, applyPlaybackEvents, type PlaybackWorld } from '../demo/playbackReconstruction.js';
import type { ProjectileEvent, TargetEvent } from '../demo/types.js';
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

const logger = new ChildLogger('DemoPlayback');

export interface DemoLifecycleDeps {
  scene: () => THREE.Scene;
  terrain: () => Terrain;
  camera: () => THREE.PerspectiveCamera;
  player: () => Player;
  demoManager: () => DemoManager | null;
  damageNumberManager: () => DamageNumberManager;
  fragMessages: () => FragMessages;
  hud: () => HUD;
  balls: Ball[];
  targets: import('../entities/balls.js').Targetable[]; // balls+crawlers live here too — keep in sync on removal
  crawlers: import('../entities/Crawler.js').Crawler[];
  turrets: import('../entities/Turretter.js').Turretter[];
  rollers: import('../entities/Roller.js').Roller[];
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
  let playbackFrozenWarnCounter = 0;
  let seekReconstructing = false;

  const playbackWorld: PlaybackWorld = {
    get scene() { return deps.scene(); },
    get terrain() { return deps.terrain(); },
    get camera() { return deps.camera(); },
    getPlayer: () => deps.player(),
    balls: deps.balls,
    debrisList: deps.world.debrisList,
    explosions: deps.world.explosions,
    implosions: deps.world.implosions,
    playbackBallById,
    playbackProjectiles,
    playbackProjectileById,
    playbackProjectileOrigin,
    get damageNumberManager() { return deps.damageNumberManager(); },
    get fragMessages() { return deps.fragMessages(); },
    get hud() { return deps.hud(); },
  };

  function updatePlaybackProjectiles(dt: number): void {
    for (let i = playbackProjectiles.length - 1; i >= 0; i--) {
      const r = playbackProjectiles[i];
      r.update(dt, deps.terrain());
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
    const terrain = deps.terrain();
    const player = deps.player();
    const playbackBallSet = new Set(playbackBallById.values());
    let frozenCount = 0;
    for (let i = deps.balls.length - 1; i >= 0; i--) {
      const b = deps.balls[i];
      if (playbackBallSet.has(b)) {
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
        logger.debug(`${frozenCount} ball(s) frozen midair (vel~0). Total playback balls: ${playbackBallSet.size}`);
      }
    } else {
      playbackFrozenWarnCounter = 0;
    }
  }

  // Shared cleanup: dispose live + playback transient objects
  function clearTransientObjects(): void {
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
    for (const d of deps.world.playerDebrisList) d.dispose();
    deps.world.playerDebrisList.length = 0;
  }

  // Snapshot existing alive balls into the demo recording — needed when recording
  // starts after balls are already in the scene (they have no Spawned event yet).
  function snapshotExistingBallsForRecording(onBallRecorded?: (ball: Ball) => void): void {
    const dm = deps.demoManager();
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
        const player = deps.player();
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
      clearTransientObjects();
      // Show overlay menu so user can replay or pick another clip
      if (document.pointerLockElement === deps.rendererCanvas) {
        document.exitPointerLock();
      }
      deps.overlay.style.display = 'flex';
      demoManager.fetchCoolShotsFromServer();
      // Resume recording for new cool shots
      demoManager.startRecording();
      onPlaybackStop();
    };

    // Clear live game objects when playback starts so they don't hang frozen in the scene
    demoManager.onPlaybackStart = () => {
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
      // Crawlers are live game objects too — dispose so they don't hang frozen
      for (const c of deps.crawlers) {
        c.dispose();
        const ti = deps.targets.indexOf(c);
        if (ti >= 0) deps.targets.splice(ti, 1);
      }
      deps.crawlers.length = 0;
      for (const t of deps.turrets) {
        t.dispose();
        const ti = deps.targets.indexOf(t);
        if (ti >= 0) deps.targets.splice(ti, 1);
      }
      deps.turrets.length = 0;
      for (const r of deps.rollers) {
        r.dispose();
        const ti = deps.targets.indexOf(r);
        if (ti >= 0) deps.targets.splice(ti, 1);
      }
      deps.rollers.length = 0;
      clearTransientObjects();
    };

    // Clear playback projectiles on seek so they don't get orphaned
    demoManager.onPlaybackSeek = () => {
      seekReconstructing = true;
      clearTransientObjects();
    };
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
