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
import {
  TARGETTYPE_CREATURE_BASE, TARGETTYPE_DEPLOY_BASE, TARGETTYPE_KILL,
  TARGETTYPE_FLAG, TARGETTYPE_PICKUP_BASE, FLAG_DEMO_ID_BASE,
} from '../demo/types.js';
import type { TargetEvent, ProjectileEvent, DemoFile } from '../demo/types.js';
import { DemoPlayer } from '../demo/DemoPlayer.js';
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
const CLIP2 = resolve(dirname(fileURLToPath(import.meta.url)),
  '../../../demos_out/midair_Cannon_4.60s_crossfire.demo');

const flatTerrain = {
  getHeight: () => 0,
  getNormal: () => new THREE.Vector3(0, 1, 0),
  reloadHeightmap() {},
  heightfield: null,
  // InstancedBlobShadows binds the shared uniform objects verbatim —
  // a flat 1×1 black map samples as height 0, same as getHeight().
  heightU: {
    heightMap: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) },
    hmWorldScale: { value: 1 },
    hScale: { value: 1 },
  },
} as unknown as Terrain;

// Build a lifecycle whose world is real playback code over stub scenery —
// the same injection seam the game uses, so the exercised path is identical.
function makePlaybackRig() {
  const scene = new THREE.Scene();
  const balls: Ball[] = [];
  const targets: Ball[] = [];
  const viewmodel = { kicks: 0, kick() { this.kicks++; } };
  initSwarms(scene, flatTerrain, {
    ball: { capacity: 512, parts: () => [
      { geometry: new THREE.SphereGeometry(1, 4, 3), material: new THREE.MeshBasicMaterial() },
    ] },
  });
  const world = {
    debrisList: [] as never[], explosions: [] as never[], implosions: [] as never[],
  } as unknown as WorldState;
  // A stub manager carrying the real wireDemoHandlers graft — the kick
  // path only exists inside onPlaybackEvent, so tests drive events through
  // it (not applyPlaybackEvents directly) or leaks past it invisible.
  const mgr = {
    isPlaying: false, mode: 'playing', currentTime: 0,
    player: { demoData: null },
    ui: { setStatus() {}, setPlaying() {} },
    fetchCoolShotsFromServer() {}, startRecording() {}, setRemoteSource() {},
    seekReconstructing: { on: false },
  } as any;
  const life = createDemoLifecycle({
    lazyScene: () => scene,
    lazyTerrain: () => flatTerrain,
    lazyCamera: () => new THREE.PerspectiveCamera(),
    lazyPlayer: () => ({ pos: new THREE.Vector3(0, 0, 0) } as unknown as Player),
    lazyDemoManager: () => mgr,
    lazyViewModel: () => viewmodel as any,
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
  life.wireDemoHandlers(mgr, () => {});
  return { scene, balls, life, mgr, viewmodel, world: life.playbackWorld };
}

const spawnedBall = (world: ReturnType<typeof makePlaybackRig>['world'],
  demoId: number, pos: THREE.Vector3, vel = new THREE.Vector3(0, -2, 0)): void => {
  applyPlaybackEvents(world, { /* eslint-disable-line */
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

// Emit events the way demo playback does — through the wired handler so
// the kick/viewmodel path runs alongside world reconstruction.
const emit = (rig: ReturnType<typeof makePlaybackRig>,
  projectiles: ProjectileEvent[], targets: TargetEvent[]): void => {
  (rig.mgr as { onPlaybackEvent(e: { projectiles: ProjectileEvent[]; targets: TargetEvent[] }): void }).onPlaybackEvent({ projectiles, targets });
};

const mkTarget = (over: Partial<TargetEvent>): TargetEvent => ({
  eventType: TargetEventType.Spawned, timestamp: 0,
  posX: 0, posY: 5, posZ: 0, velX: 0, velY: 0, velZ: 0,
  targetId: 1, targetType: 0, health: 30,
  hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
  ...over,
});

describe('playback audit — every lane animates', () => {
  it('creature proxies integrate ballistic drift (gravity species falls)', () => {
    const rig = makePlaybackRig();
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      targetId: 901, targetType: TARGETTYPE_CREATURE_BASE + 0, posY: 20,
    })] });
    const c = rig.world.playbackCreatureById.get(901)!;
    expect(c).toBeTruthy();
    const y0 = c.pos.y;
    for (let i = 0; i < 60; i++) {rig.life.updateBallsPlayback(1 / 60);}
    expect(c.pos.y).toBeLessThan(y0 - 0.5); // crawler falls, mesh follows
    expect(c.mesh.position.y).toBe(c.pos.y);
  });

  it('deployable spawn → scene mesh; down state dims; destroy removes', () => {
    const rig = makePlaybackRig();
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      targetId: 902, targetType: TARGETTYPE_DEPLOY_BASE + 1, // mine — pops on destroy
    })] });
    const d = rig.world.playbackDeployableById.get(902)!;
    expect(d).toBeTruthy();
    expect(rig.scene.children).toContain(d.mesh);
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      eventType: TargetEventType.Hit, targetId: 902, targetType: TARGETTYPE_DEPLOY_BASE + 1, health: 0,
    })] });
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      eventType: TargetEventType.Destroyed, targetId: 902, targetType: TARGETTYPE_DEPLOY_BASE + 1,
    })] });
    expect(rig.world.playbackDeployableById.has(902)).toBe(false);
    expect(rig.scene.children).not.toContain(d.mesh);
    expect(rig.world.explosions.length).toBeGreaterThan(0); // mine pop
  });

  it('flag spawn exists; carried flag re-pins to the replayed carrier', () => {
    const rig = makePlaybackRig();
    const flagId = FLAG_DEMO_ID_BASE | 0;
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      targetId: flagId, targetType: TARGETTYPE_FLAG, health: 1,
      peakPosX: 3 + 1, hasPeakPosition: true, // carrier roster idx 3
    })] });
    const flag = rig.world.playbackFlags.get(flagId)!;
    expect(flag).toBeTruthy();
    // Carrier pos provider — the seam updatePlaybackFlags consults.
    rig.world.remotePosAt = (idx: number) => idx === 3 ? new THREE.Vector3(10, 2, -5) : null;
    rig.life.updateBallsPlayback(1 / 60);
    expect(flag.position.x).toBeCloseTo(10, 1);
    expect(flag.position.z).toBeCloseTo(-5, 1);
    expect(flag.visible).toBe(true);
  });

  it('pickup spawns a gem and Destroyed removes it', () => {
    const rig = makePlaybackRig();
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      targetId: 903, targetType: TARGETTYPE_PICKUP_BASE + 0,
    })] });
    expect(rig.world.playbackPickups.has(903)).toBe(true);
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      eventType: TargetEventType.Destroyed, targetId: 903, targetType: TARGETTYPE_PICKUP_BASE,
    })] });
    expect(rig.world.playbackPickups.has(903)).toBe(false);
  });

  it('viewmodel kicks only on local-lane shots (deploy leak regression)', () => {
    const rig = makePlaybackRig();
    const mkFired = (targetId: number): ProjectileEvent => ({
      eventType: ProjectileEventType.Fired, timestamp: 0,
      posX: 0, posY: 10, posZ: 0, velX: 0, velY: 0, velZ: 60,
      projectileId: targetId + 100, weaponType: 254, surfaceNormalX: 0,
      surfaceNormalY: 0, surfaceNormalZ: 0, targetId, targetType: 0,
      hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
    // The deploy-shot bug: a turret bolt minted targetId 0 → kicked.
    emit(rig, [mkFired(5)], []); // remote shooter rosterIdx 4
    emit(rig, [mkFired(3)], []); // remote shooter rosterIdx 2
    expect(rig.viewmodel.kicks).toBe(0);
    emit(rig, [mkFired(0)], []); // the local player's own shot
    expect(rig.viewmodel.kicks).toBe(1);
  });

  it('kill events emit a burst (not silently dropped)', () => {
    const rig = makePlaybackRig();
    const before = rig.world.explosions.length;
    applyPlaybackEvents(rig.world, { projectiles: [], targets: [mkTarget({
      targetType: TARGETTYPE_KILL, posY: 30,
    })] });
    expect(rig.world.explosions.length).toBe(before + 1);
  });
});

// Real-clip remote-replica audit: interpolation must animate, not freeze.
describe.skipIf(!existsSync(CLIP))('remote replica interpolation', () => {
  it('interpolated remotes move between recorded frames', () => {
    const demo: DemoFile = deserializeDemo(readFileSync(CLIP).buffer);
    const player = new DemoPlayer();
    player.load(demo);
    player.currentTime = 1.0;
    const s0 = player.getRemoteStates();
    player.currentTime = 1.5;
    const s1 = player.getRemoteStates();
    expect(s1.length).toBeGreaterThan(0);
    let moved = 0;
    for (const a of s0) {
      const b = s1.find(r => r.rosterIdx === a.rosterIdx);
      if (!b) {continue;}
      const d2 = (a.posX - b.posX) ** 2 + (a.posY - b.posY) ** 2 + (a.posZ - b.posZ) ** 2;
      if (d2 > 0.01) {moved++;}
      expect(Number.isFinite(b.posX + b.posY + b.posZ + b.yaw + b.pitch)).toBe(true);
    }
    // In a firefight clip most replicas move; a dead interp freezes all.
    expect(moved).toBeGreaterThan(s0.length / 3);
  });
});

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
      surfaceNormalZ: 0, targetId: 1, targetType: 0, hasPeakPosition: false,
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

/** Replays a demo's full event stream through the real lifecycle in one
 *  pass, collecting per-lane traces each assertion reads back. Mirrors the
 *  timeline playback (30fps steps) so what the test sees is what a render
 *  would see. */
function scrubDemo(demo: DemoFile) {
  const rig = makePlaybackRig();
  const world = rig.world;
  const trace = {
    ballBirths: new Map<number, THREE.Vector3>(),
    creatureBirths: new Map<number, THREE.Vector3>(),
    projOrigins: new Map<number, THREE.Vector3>(),
    deploySpawns: new Set<number>(),
    flagEvents: 0,
    pickupSpawns: new Set<number>(),
    killBursts: 0,
  };
  let pi = 0, ti = 0;
  const dt = 1 / 30;
  const expBase = world.explosions.length;
  for (let t = 0; t < demo.header.duration; t += dt) {
    const proj: ProjectileEvent[] = [];
    while (pi < demo.projectileEvents.length && demo.projectileEvents[pi]!.timestamp <= t) {proj.push(demo.projectileEvents[pi]!); pi++;}
    const tgt: TargetEvent[] = [];
    while (ti < demo.targetEvents.length && demo.targetEvents[ti]!.timestamp <= t) {tgt.push(demo.targetEvents[ti]!); ti++;}
    for (const e of tgt) {
      if (e.eventType === TargetEventType.Spawned && e.targetType < 32) {
        trace.ballBirths.set(e.targetId, new THREE.Vector3(e.posX, e.posY, e.posZ));
      }
      if (e.eventType === TargetEventType.Spawned
          && e.targetType >= TARGETTYPE_CREATURE_BASE && e.targetType < TARGETTYPE_DEPLOY_BASE) {
        trace.creatureBirths.set(e.targetId, new THREE.Vector3(e.posX, e.posY, e.posZ));
      }
      if (e.eventType === TargetEventType.Spawned
          && e.targetType >= TARGETTYPE_DEPLOY_BASE && e.targetType < TARGETTYPE_KILL) {
        trace.deploySpawns.add(e.targetId);
      }
      if (e.targetType === TARGETTYPE_FLAG) {trace.flagEvents++;}
      if (e.eventType === TargetEventType.Spawned && e.targetType >= TARGETTYPE_PICKUP_BASE) {
        trace.pickupSpawns.add(e.targetId);
      }
    }
    for (const e of proj) {
      if (e.eventType === ProjectileEventType.Fired) {
        trace.projOrigins.set(e.projectileId, new THREE.Vector3(e.posX, e.posY, e.posZ));
      }
    }
    emit(rig, proj, tgt);
    rig.life.updateBallsPlayback(dt);
    rig.life.updatePlaybackProjectiles(dt);
  }
  trace.killBursts = world.explosions.length - expBase;
  return { world, trace, scene: rig.scene, kicks: rig.viewmodel.kicks };
}

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
    expect(violations.join('\n')).toBe('');
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

  it('kick audit — only the clip POV shots kick, nothing else', () => {
    const zeroShots = demo.projectileEvents.filter(
      e => e.eventType === ProjectileEventType.Fired && e.targetId === 0 && e.timestamp > 0.01,
    );
    // A promoted POV clip: local shots exist but stay a small minority —
    // a foreign-shot leak floods this count (was 18 incl. observer+deploys).
    expect(zeroShots.length).toBeGreaterThan(0);
    expect(zeroShots.length).toBeLessThan(20);
    // And the runtime agrees: kicks fired exactly once per local-lane shot.
    const { kicks } = scrubDemo(demo);
    expect(kicks).toBe(zeroShots.length + demo.projectileEvents.filter(
      e => e.eventType === ProjectileEventType.Fired && e.targetId === 0 && e.timestamp <= 0.01,
    ).length);
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

// Crossfire clip carries the lanes henge lacks: 27 creature events, 109 flag,
// 34 pickup — every lane asserted against real recorded data.
describe.skipIf(!existsSync(CLIP2))('crossfire clip — remaining lanes on real data', () => {
  let demo2: DemoFile;
  beforeAll(() => { demo2 = deserializeDemo(readFileSync(CLIP2).buffer); });

  it('every spawned creature animates or dies — none freeze', () => {
    const { world, trace } = scrubDemo(demo2);
    expect(trace.creatureBirths.size).toBeGreaterThan(3);
    const violations: string[] = [];
    for (const [id, born] of trace.creatureBirths) {
      const c = world.playbackCreatureById.get(id);
      if (!c || c.dead) {continue;}
      const moved = c.pos.distanceTo(born) > 0.3;
      const settled = c.vel.lengthSq() < 0.01;
      if (!moved && !settled) {
        violations.push(`creature ${id} frozen at ${c.pos.y.toFixed(1)}`);
      }
    }
    expect(violations.join('\n')).toBe('');
  });

  it('marker lanes land: flag events rebuild proxies, pickups spawn, kills burst', () => {
    const { world, trace } = scrubDemo(demo2);
    expect(trace.flagEvents).toBeGreaterThan(10);
    // Pickups that were spawned and never taken survive the clip in the map.
    expect(trace.pickupSpawns.size).toBeGreaterThan(5);
    const livePickups = [...trace.pickupSpawns].filter(id => world.playbackPickups.has(id));
    expect(world.playbackPickups.size).toBeGreaterThan(0);
    expect(livePickups.length + world.playbackPickups.size).toBeGreaterThanOrEqual(trace.pickupSpawns.size);
    // Kill events emit a visible burst — a silently dropped kill fails here.
    expect(trace.killBursts).toBeGreaterThan(0);
  });

  it('deployable spawns land as scene meshes', () => {
    const { world, trace, scene } = scrubDemo(demo2);
    for (const id of trace.deploySpawns) {
      const d = world.playbackDeployableById.get(id);
      if (!d) {continue;} // destroyed mid-clip — fine
      expect(scene.children).toContain(d.mesh);
    }
  });
});

// Cross-lane u16 id aliasing: nextTargetId() sweeps the full space, so in
// any long recording a ball's id WILL land on flag/pickup/creature
// namespaces. The alive table must not let lanes clobber each other.
describe('cross-lane id aliasing', () => {
  it('a ball Destroyed at a flag-id does not kill the flag snapshot', async () => {
    const { findAliveTargets } = await import('../demo/demoClip.js');
    const flagEv = mkTarget({ targetId: FLAG_DEMO_ID_BASE | 1, targetType: TARGETTYPE_FLAG });
    const ballSpawn = mkTarget({ targetId: FLAG_DEMO_ID_BASE | 1, targetType: 0 });
    const ballDie = mkTarget({ eventType: TargetEventType.Destroyed, targetId: FLAG_DEMO_ID_BASE | 1, targetType: 0 });
    const alive = findAliveTargets([ballSpawn, flagEv, ballDie], 10);
    const entries = [...alive.values()];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.targetType).toBe(TARGETTYPE_FLAG); // flag survives, ball is gone
  });

  it('a flag edge does not overwrite a live ball snapshot', async () => {
    const { findAliveTargets } = await import('../demo/demoClip.js');
    const ballSpawn = mkTarget({ targetId: FLAG_DEMO_ID_BASE | 1, targetType: 0, posY: 50 });
    const flagEv = mkTarget({ targetId: FLAG_DEMO_ID_BASE | 1, targetType: TARGETTYPE_FLAG });
    const alive = findAliveTargets([ballSpawn, flagEv], 10);
    const entries = [...alive.values()];
    expect(entries).toHaveLength(2);
    expect(entries.some(e => e.targetType === 0)).toBe(true);
    expect(entries.some(e => e.targetType === TARGETTYPE_FLAG)).toBe(true);
  });
});

// A re-fired Spawned at a live id (id wrap, or synthetic+real pair at a
// clip boundary) must re-key the existing ball — not push a second one
// that nobody updates.
it('duplicate Spawned at a live id does not orphan a frozen ball', () => {
  const rig = makePlaybackRig();
  spawnedBall(rig.world, 777, new THREE.Vector3(0, 30, 0));
  spawnedBall(rig.world, 777, new THREE.Vector3(10, 40, 0));
  expect(rig.world.playbackBallById.size).toBe(1);
  expect(rig.balls.filter(b => (rig.world.playbackBallById as Map<number, Ball>).get(777) === b).length).toBe(1);
  expect(rig.world.playbackBallById.get(777)!.pos.x).toBe(10); // re-keyed to the latest spawn
});
