// Playback differential audit — validates what demovalidate cannot: that a
// deserialized .demo, driven through the REAL playback runtime
// (createDemoLifecycle + applyPlaybackEvents), produces a world that moves.
// The file-level validator proves the bytes are well-formed; this proves the
// replay actually animates. Frozen-ball class bugs (entities spawned but
// never updated) fail here instantly.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deserializeDemo } from '../demo/demoReader.js';
import { applyPlaybackEvents } from '../demo/playbackReconstruction.js';
import { ProjectileEventType, TargetEventType } from '../demo/types.js';
import type { TargetEvent, ProjectileEvent } from '../demo/types.js';
import { createDemoLifecycle } from '../game/demoLifecycle.js';
import { initSwarms } from '../entities/swarms.js';
import { Ball } from '../entities/balls.js';
import type { Terrain } from '../world/terrain.js';
import type { Player } from '../entities/Player.js';
import type { WorldState } from '../game/worldState.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';

const CLIP = resolve(dirname(fileURLToPath(import.meta.url)),
  '../../../demos_out/midair_BoltLauncher_0.35s_henge.demo');

const flatTerrain = {
  getHeight: () => 0,
  getNormal: () => new THREE.Vector3(0, 1, 0),
  reloadHeightmap() {},
  heightfield: null,
} as unknown as Terrain;

// Build a lifecycle whose world is real playback code over stub scenery —
// the same injection seam the game uses, so the exercised path is identical.
function makePlaybackRig() {
  const scene = new THREE.Scene();
  const balls: Ball[] = [];
  const targets: Ball[] = [];
  initSwarms(scene, flatTerrain, {
    ball: { capacity: 512, parts: () => [
      { geometry: new THREE.SphereGeometry(1, 4, 3), material: new THREE.MeshBasicMaterial() },
    ] },
  });
  const world = {
    debrisList: [] as never[], explosions: [] as never[], implosions: [] as never[],
  } as unknown as WorldState;
  const life = createDemoLifecycle({
    lazyScene: () => scene,
    lazyTerrain: () => flatTerrain,
    lazyCamera: () => new THREE.PerspectiveCamera(),
    lazyPlayer: () => ({ pos: new THREE.Vector3(0, 0, 0) } as unknown as Player),
    lazyDemoManager: () => null,
    lazyViewModel: () => null,
    damageNumberManager: () => ({ spawn() {} } as unknown as DamageNumberManager),
    fragMessages: () => ({ showScore() {} } as unknown as FragMessages),
    lazyHud: () => ({ showHitMarker() {} } as unknown as HUD),
    balls,
    targets,
    crawlers: [], turrets: [], rollers: [], seekers: [],
    overlords: [], mines: [], totems: [], rakks: [],
    world,
    overlay: null as unknown as HTMLElement,
    rendererCanvas: null as unknown as HTMLCanvasElement,
  });
  return { scene, balls, life, world: life.playbackWorld };
}

const spawnedBall = (world: ReturnType<typeof makePlaybackRig>['world'],
  demoId: number, pos: THREE.Vector3, vel = new THREE.Vector3(0, -2, 0)): void => {
  applyPlaybackEvents(world, {
    projectiles: [],
    targets: [{
      eventType: TargetEventType.Spawned, timestamp: 0,
      posX: pos.x, posY: pos.y, posZ: pos.z,
      velX: vel.x, velY: vel.y, velZ: vel.z,
      targetId: demoId, targetType: 0, health: 30,
      hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    }],
  });
};

describe('playback audit — entities must animate', () => {
  it('spawned playback balls integrate gravity (frozen-ball regression)', () => {
    const rig = makePlaybackRig();
    // Demo id deliberately differs from Ball's internal nextTargetId() —
    // the exact mismatch that froze every playback ball midair.
    spawnedBall(rig.world, 42_000, new THREE.Vector3(0, 80, 0));
    const ball = rig.world.playbackBallById.get(42_000)!;
    expect(ball).toBeTruthy();
    expect(ball.id).not.toBe(42_000); // proves the map key ≠ instance id
    const y0 = ball.pos.y;
    for (let i = 0; i < 60; i++) {rig.life.updateBallsPlayback(1 / 60);}
    expect(ball.pos.y).toBeLessThan(y0 - 1); // fell under gravity
  });

  it('non-playback balls are NOT touched by the playback loop', () => {
    const rig = makePlaybackRig();
    const live = new Ball(rig.scene, flatTerrain, 0);
    live.pos.set(0, 50, 0); live.vel.set(0, 0, 0);
    rig.balls.push(live);
    const y0 = live.pos.y;
    for (let i = 0; i < 30; i++) {rig.life.updateBallsPlayback(1 / 60);}
    expect(live.pos.y).toBe(y0); // live game balls frozen during playback
  });

  it('fired events produce projectiles that leave their origin', () => {
    const rig = makePlaybackRig();
    const ev: ProjectileEvent = {
      eventType: ProjectileEventType.Fired, timestamp: 0,
      posX: 0, posY: 50, posZ: 0, velX: 0, velY: 0, velZ: 60,
      projectileId: 7, weaponType: 0, surfaceNormalX: 0, surfaceNormalY: 0,
      surfaceNormalZ: 0, targetId: 1, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    };
    applyPlaybackEvents(rig.world, { projectiles: [ev], targets: [] });
    const r = rig.world.playbackProjectileById.get(7)!;
    expect(r).toBeTruthy();
    const origin = r.pos.clone();
    for (let i = 0; i < 18; i++) {rig.life.updatePlaybackProjectiles(1 / 60);}
    expect(r.pos.distanceTo(origin)).toBeGreaterThan(5);
  });
});

// File-level differential audit: replay the real clip through real playback,
// then every spawned entity must have moved (or died) — never froze midair.
describe.skipIf(!existsSync(CLIP))('recorded clip audit', () => {
  let demo: ReturnType<typeof deserializeDemo>;
  beforeAll(() => { demo = deserializeDemo(readFileSync(CLIP).buffer); });

  it('every spawned ball animates or rests on ground — none hover midair', () => {
    const rig = makePlaybackRig();
    const world = rig.world;
    const birthPos = new Map<number, THREE.Vector3>();
    const spawnT = new Map<number, number>();
    let pi = 0, ti = 0;
    const dt = 1 / 30;
    for (let t = 0; t < demo.header.duration; t += dt) {
      const proj: ProjectileEvent[] = [];
      while (pi < demo.projectileEvents.length && demo.projectileEvents[pi]!.timestamp <= t) {proj.push(demo.projectileEvents[pi]!); pi++;}
      const tgt: TargetEvent[] = [];
      while (ti < demo.targetEvents.length && demo.targetEvents[ti]!.timestamp <= t) {tgt.push(demo.targetEvents[ti]!); ti++;}
      // snapshot birth state before apply
      for (const e of tgt) {
        if (e.eventType === TargetEventType.Spawned && e.targetType < 32) {
          birthPos.set(e.targetId, new THREE.Vector3(e.posX, e.posY, e.posZ));
          spawnT.set(e.targetId, t);
        }
      }
      applyPlaybackEvents(world, { projectiles: proj, targets: tgt });
      rig.life.updateBallsPlayback(dt);
      rig.life.updatePlaybackProjectiles(dt);
    }
    // After the full clip, each spawned ball either moved, died, or rests
    // within 1.5m of ground — the frozen-midair signature is none of those.
    const violations: string[] = [];
    for (const [id, born] of birthPos) {
      const ball = world.playbackBallById.get(id);
      if (!ball || ball.dead || ball.disposed) {continue;}
      const moved = ball.pos.distanceTo(born) > 0.5;
      const resting = Math.abs(ball.pos.y - flatTerrain.getHeight(0, 0)) < ball.radius + 1.5
        && ball.vel.lengthSq() < 1;
      if (!moved && !resting) {
        violations.push(`ball ${id} born at y=${born.y.toFixed(0)} frozen at y=${ball.pos.y.toFixed(0)} (vel ${ball.vel.length().toFixed(2)})`);
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
    expect(birthPos.size).toBeGreaterThan(10); // clip actually had balls
  });

  it('every fired projectile moved or terminated', () => {
    const rig = makePlaybackRig();
    const world = rig.world;
    const origins = new Map<number, THREE.Vector3>();
    let pi = 0, ti = 0;
    const dt = 1 / 30;
    for (let t = 0; t < demo.header.duration; t += dt) {
      const proj: ProjectileEvent[] = [];
      while (pi < demo.projectileEvents.length && demo.projectileEvents[pi]!.timestamp <= t) {proj.push(demo.projectileEvents[pi]!); pi++;}
      const tgt: TargetEvent[] = [];
      while (ti < demo.targetEvents.length && demo.targetEvents[ti]!.timestamp <= t) {tgt.push(demo.targetEvents[ti]!); ti++;}
      for (const e of proj) {
        if (e.eventType === ProjectileEventType.Fired) {
          origins.set(e.projectileId, new THREE.Vector3(e.posX, e.posY, e.posZ));
        }
      }
      applyPlaybackEvents(world, { projectiles: proj, targets: tgt });
      rig.life.updateBallsPlayback(dt);
      rig.life.updatePlaybackProjectiles(dt);
    }
    const stuck: number[] = [];
    let live = 0;
    for (const [id, o] of origins) {
      const r = world.playbackProjectileById.get(id);
      if (!r) {continue;} // terminated — fine
      live++;
      if (r.pos.distanceTo(o) < 0.5) {stuck.push(id);}
    }
    expect(stuck, `stuck shells: ${stuck.join(',')}`).toHaveLength(0);
    expect(origins.size).toBeGreaterThan(100);
  });

  it('kick audit — only the clip POV shots carry targetId 0', () => {
    const zeroShots = demo.projectileEvents.filter(
      e => e.eventType === ProjectileEventType.Fired && e.targetId === 0 && e.timestamp > 0.01,
    );
    // A promoted POV clip: local shots exist but stay a small minority —
    // a foreign-shot leak floods this count (was 18 incl. observer+deploys).
    expect(zeroShots.length).toBeGreaterThan(0);
    expect(zeroShots.length).toBeLessThan(20);
  });

  it('roster refs are in bounds and local frames are finite/monotonic', () => {
    for (const f of demo.remoteFrames) {
      expect(f.rosterIdx).toBeLessThan(demo.roster.length);
      expect(Number.isFinite(f.posX + f.posY + f.posZ + f.yaw + f.pitch)).toBe(true);
    }
    let prev = -Infinity;
    for (const f of demo.frames) {
      expect(Number.isFinite(f.posX + f.posY + f.posZ + f.yaw + f.pitch)).toBe(true);
      expect(f.timestamp).toBeGreaterThanOrEqual(prev);
      prev = f.timestamp;
    }
  });
});
