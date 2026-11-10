/* oxlint-disable typescript/no-explicit-any -- prototype stubs need loosely-typed privates */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { RemoteInterp, type InterpHost } from '../entities/remoteInterp.js';
import { Nugget } from '../entities/Nugget.js';

// The 2026-11-10 diagnostics dump: reconnect replayed remote seats and
// nugget rests that were CORRECT by design - the detectors misfired on
// the recovery path. These pin the three fixes.

const mkHost = (): InterpHost => ({
  position: new THREE.Vector3(),
  previousPosition: new THREE.Vector3(),
  rotation: { yaw: 0, pitch: 0, roll: 0 },
  velocity: new THREE.Vector3(),
  serverVelocity: new THREE.Vector3(),
  terrain: null, playerId: 'dbg', armorClass: 'scout',
});

afterEach(() => { vi.restoreAllMocks(); });

describe('remoteInterp reseat - reconnect purge must not flag or freeze', (): void => {
  it('post-reseat push at new seat: no teleport GLITCH, no out-of-order drop', (): void => {
    const err = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const ri = new RemoteInterp(mkHost());
    // Old room: serverMs large (tickSeq×50), body at A.
    const A = { x: 0, y: 60, z: 0 };
    for (let i = 0; i < 4; i += 1) {
      ri.onUpdate({ x: A.x + i, y: A.y, z: A.z }, { yaw: 0, pitch: 0 }, 50, { x: 20, y: 0, z: 0 }, 1_000_000 + i * 50);
    }
    expect(ri.wirePosition.x).toBeGreaterThan(0);
    // Reconnect: purgeStaleRemotes teleports the body to the new room's
    // seat 100m away - this is a DECLARED move, not a wire anomaly.
    const B = new THREE.Vector3(100, 60, 0);
    ri.reseat(B);
    // First push from the new room: small step from B, serverMs REWOUND
    // (a restarted room's tickSeq is small). Pre-fix: lastServerUpdateMs
    // still held 1_000_150 → stamp < prev → dropped as out-of-order →
    // remote frozen at the old seat. And lastServerPosition stayed at A,
    // so a later push flagged a phantom 100m teleport.
    ri.onUpdate({ x: B.x + 1, y: B.y, z: B.z }, { yaw: 0, pitch: 0 }, 50, { x: 20, y: 0, z: 0 }, 500);
    expect(ri.wirePosition.x).toBeCloseTo(B.x + 1, 3); // accepted, not dropped
    expect(err).not.toHaveBeenCalled();
  });
});

describe('nugget nugrest - hidden-tab stalls are designed divergence', (): void => {
  it('wall-clock gap >300ms arms throttleBurst: serverRest divergence is not a parity miss', (): void => {
    const err = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    // Bare prototype instance - the pooled-mesh ctor needs WebGL; only
    // the tumble fields matter here.
    const n = Object.create(Nugget.prototype) as any;
    n.pos = new THREE.Vector3(0, 10, 0);
    n.prevPos = new THREE.Vector3(0, 10, 0);
    n.vel = new THREE.Vector3(1, 0, 0);
    n.tumbleAcc = 0;
    n.settled = false;
    n.throttleBurst = false;
    n.lastTickMs = 0;
    n.collected = false;
    n.dead = false;
    const terrain = { getHeight: (): number => 0 } as any;

    // Simulate: ticking normally, then a fully-hidden stretch - ZERO
    // frames ran, so no dt spike ever trips the old dt>0.3 check.
    n.serverTumble(0.05, terrain);
    n.lastTickMs = performance.now() - 1000; // wall clock says 1s stalled
    n.serverTumble(0.05, terrain);
    expect(n.throttleBurst).toBe(true);

    // The server's real-time rest lands >7m off the stalled prediction -
    // designed divergence, must NOT parity-miss.
    n.serverRest({ x: 20, y: 0, z: 0 });
    expect(err).not.toHaveBeenCalled();
    expect(n.settled).toBe(true);
    expect(n.pos.x).toBe(20);
  });

  it('no stall: a real >7m divergence still parity-misses', (): void => {
    const err = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const n = Object.create(Nugget.prototype) as any;
    n.pos = new THREE.Vector3(0, 10, 0);
    n.prevPos = new THREE.Vector3(0, 10, 0);
    n.vel = new THREE.Vector3(1, 0, 0);
    n.tumbleAcc = 0;
    n.settled = false;
    n.throttleBurst = false;
    n.lastTickMs = 0;
    n.collected = false;
    n.dead = false;
    const terrain = { getHeight: (): number => 0 } as any;

    n.serverTumble(0.05, terrain); // normal tick, no gap
    expect(n.throttleBurst).toBe(false);
    n.serverRest({ x: 20, y: 0, z: 0 }); // real mirror-math bug class
    expect(err.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(0);
  });
});
