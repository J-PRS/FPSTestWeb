/* oxlint-disable vitest/no-conditional-in-test -- table harness */
// C4 remote edge replay  -  the relayed inputMove edges must (a) take the
// body over from interp, (b) resync on >3m record drift, (c) pull sub-snap
// drift toward truth, (d) stay alive on a record-fed stream while the
// change-only edge stream is silent, and (e) drop dup/OOO seqs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { RemoteInterp, type InterpHost } from '../entities/remoteInterp.js';
import type { Terrain } from '../world/terrain.js';
import { classCapsule } from '../../../shared/botClasses.js';

// Flat world at y=0  -  enough surface for the shared MoveSim to walk on.
const flatTerrain = {
  getHeight: (): number => 0,
  getNormal: (): { x: number; y: number; z: number } => ({ x: 0, y: 1, z: 0 }),
} as unknown as Terrain;

class Host implements InterpHost {
  position = new THREE.Vector3();
  previousPosition = new THREE.Vector3();
  rotation = { yaw: 0, pitch: 0, roll: 0 };
  velocity = new THREE.Vector3();
  serverVelocity = new THREE.Vector3();
  terrain = flatTerrain;
  playerId = 'replay-target';
  armorClass = 'medium';
}

const EYE = classCapsule('medium').eye;
const P0 = { x: 10, y: EYE, z: 10 };
const ROT = { yaw: 0, pitch: 0 };
const FWD = { forward: 1, right: 0, jump: 0, ski: 0, jet: 0 };

function seeded(): { h: Host; ri: RemoteInterp } {
  const h = new Host();
  const ri = new RemoteInterp(h);
  ri.onUpdate(P0, ROT, 50, { x: 0, y: 0, z: 0 }, 0);
  h.position.set(P0.x, P0.y, P0.z);
  ri.onInputEdge(1, 0, FWD);
  return { h, ri };
}

describe('remoteReplay  -  C4 edge replay', (): void => {
  beforeEach((): void => { vi.useFakeTimers(); });
  afterEach((): void => { vi.useRealTimers(); });

  it('an edge seeds the replay sim and step() owns the body', (): void => {
    const { h, ri } = seeded();
    const x0 = h.position.x;
    for (let i = 0; i < 60; i += 1) {ri.step(1 / 60, false);}
    expect(ri.simulating).toBe(true);
    // forward=1 at yaw 0 walks +z  -  the body must have moved from spawn
    expect(Math.abs(h.position.z - P0.z) + Math.abs(h.position.x - x0)).toBeGreaterThan(0.5);
  });

  it('dup/OOO edge seqs are dropped (seq gate)', (): void => {
    const { h, ri } = seeded();
    ri.onInputEdge(1, 0, { forward: -1, right: 0 }); // replayed seq  -  must not flip input
    ri.onInputEdge(0, 0, { forward: -1, right: 0 });
    for (let i = 0; i < 60; i += 1) {ri.step(1 / 60, false);}
    expect(h.position.z).toBeGreaterThan(P0.z); // still walking +z
  });

  it('record >3m off the replayed state snaps the sim back to wire truth', (): void => {
    const { h, ri } = seeded();
    const far = { x: P0.x + 8, y: P0.y, z: P0.z };
    ri.onUpdate(far, ROT, 50, { x: 0, y: 0, z: 0 }, 50);
    ri.step(0, false);
    expect(h.position.distanceTo(new THREE.Vector3(far.x, far.y, far.z))).toBeLessThan(0.5);
  });

  it('record <3m off pulls 25% of the residual drift', (): void => {
    const { h, ri } = seeded();
    // One frame of walk so the sim sits a hair off the wire, then a record
    // planted 1m sideways pulls the residual, not the walk.
    ri.step(1 / 60, false);
    const gapBefore = h.position.clone().sub(new THREE.Vector3(P0.x + 1, P0.y, P0.z)).length();
    ri.onUpdate({ x: P0.x + 1, y: P0.y, z: P0.z }, ROT, 50, { x: 0, y: 0, z: 0 }, 50);
    ri.step(0, false);
    const gapAfter = h.position.distanceTo(new THREE.Vector3(P0.x + 1, P0.y, P0.z));
    expect(gapAfter).toBeLessThan(gapBefore);
    expect(gapAfter).toBeGreaterThan(0);
  });

  it('records keep replay alive past 1.5s of edge silence (held input)', (): void => {
    const { h, ri } = seeded();
    vi.advanceTimersByTime(1200); // close to the 1.5s freshness gate
    ri.onUpdate({ x: P0.x, y: P0.y, z: P0.z + 1 }, ROT, 50, { x: 0, y: 0, z: 0 }, 60_000);
    vi.advanceTimersByTime(1200); // now 2.4s past the edge  -  dead without refresh
    ri.step(1 / 60, false);
    expect(ri.simulating).toBe(true); // record refresh kept ownership
  });

  it('reconcile tracks yaw on every record, not only on snaps', (): void => {
    const { h, ri } = seeded();
    ri.onUpdate(P0, { yaw: Math.PI / 2, pitch: 0 }, 50, { x: 0, y: 0, z: 0 }, 50);
    ri.onInputEdge(2, 0, FWD);
    for (let i = 0; i < 60; i += 1) {ri.step(1 / 60, false);}
    // forward=(sin yaw,cos yaw): yaw pi/2 walks +x  -  a stale yaw walks +z
    expect(h.position.x).toBeGreaterThan(P0.x + 0.3);
    expect(Math.abs(h.position.z - P0.z)).toBeLessThan(Math.abs(h.position.x - P0.x));
  });
});
