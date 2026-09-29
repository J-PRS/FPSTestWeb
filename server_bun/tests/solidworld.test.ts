import { describe, expect, test } from 'bun:test';
import { SolidWorld, segSolidHit } from '../../shared/solidWorld.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import { MoveSim, MOVEMENT_CONFIG, type MoveState } from '../../shared/movement.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import type { Vec3Like } from '../../shared/movement.ts';

const H = MOVEMENT_CONFIG.playerHeight; // pos.y is capsule top

// Flat plain at y=0 — the solid layer alone decides contact outcomes.
const flat = { getHeight: () => 0, getNormal: (_x: number, _z: number, out: Vec3Like) => { out.x = 0; out.y = 1; out.z = 0; return out; } };

const wall: StructureSpec[] = [
  { kind: 'wall', pos: { x: 10, y: 0, z: 0 }, size: { x: 1, y: 6, z: 10 } }, // 6m wall at x=10
];
const platform: StructureSpec[] = [
  { kind: 'box', pos: { x: 0, y: 0, z: 0 }, size: { x: 10, y: 3, z: 10 } }, // 3m platform under origin
];
const lowStep: StructureSpec[] = [
  { kind: 'box', pos: { x: 10, y: 0, z: 0 }, size: { x: 4, y: 0.4, z: 10 } }, // knee-high ledge
];

function simAt(x: number, y: number, z: number, extra?: Partial<MoveState>): MoveState {
  return {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, onGround: true, ...extra,
  };
}

describe('SolidWorld', () => {
  test('topAt reports the piece top inside the footprint only', () => {
    const w = SolidWorld.fromSpecs(wall);
    expect(w.topAt(10, 0)).toBeCloseTo(6);
    expect(w.topAt(5, 0)).toBe(-Infinity);
    expect(w.topAt(10, 6)).toBe(-Infinity); // past z half-extent 5
  });

  test('resolveBody pushes the capsule out of a wall side, kills inward vel', () => {
    const w = SolidWorld.fromSpecs(wall);
    const s = simAt(9.2, H + 1, 0, { vel: { x: 5, y: 0, z: 0 } }); // feet at y=1, inside wall span
    w.resolveBody(s);
    expect(s.pos.x).toBeLessThan(9.2);          // pushed -x back out of the face
    expect(s.vel.x).toBeCloseTo(0);             // into-face velocity killed, slide stays
  });

  test('resolveBody leaves bodies above the top face alone (floor owns it)', () => {
    const w = SolidWorld.fromSpecs(platform);
    const s = simAt(0, 3 + H + 0.01, 0);        // feet just above the 3m top
    w.resolveBody(s);
    expect(s.pos.x).toBe(0);
  });

  test('ceiling: head under a box underside drops out, upward vel dies', () => {
    const beam: StructureSpec[] = [
      { kind: 'box', pos: { x: 0, y: 2, z: 0 }, size: { x: 10, y: 1, z: 10 } }, // underside at y=2
    ];
    const w = SolidWorld.fromSpecs(beam);
    const s = simAt(0, 2.4, 0, { vel: { x: 0, y: 8, z: 0 }, onGround: false }); // head at 2.4 inside beam
    w.resolveBody(s);
    expect(s.vel.y).toBe(0);
  });

  test('MoveSim: a runner into the wall is stopped, not teleported up', () => {
    const surf = {
      ...flat,
      resolveBody(s: MoveState) { SolidWorld.fromSpecs(wall).resolveBody(s); },
      getHeight(x: number, z: number) { const w = SolidWorld.fromSpecs(wall); const t = w.topAt(x, z); return t > 0 ? t : 0; },
    };
    const sim = new MoveSim(surf, simAt(7, H + 0.1, 0));
    sim.setInput({ forward: 1 }); // yaw=0 → forward is +z... walk sideways: aim right
    sim.state.yaw = Math.PI / 2;  // forward now +x, toward the wall at x=10
    for (let i = 0; i < 120; i++) sim.update(1 / 30);
    expect(sim.state.pos.x).toBeLessThan(9.6); // never reached the face (x≈9.5+r)
    expect(sim.state.pos.y).toBeLessThan(4);   // and never stepped onto the 6m top
  });

  test('MoveSim: a body over the platform top lands and stays grounded', () => {
    const w = SolidWorld.fromSpecs(platform);
    const surf = {
      ...flat,
      resolveBody(s: MoveState) { w.resolveBody(s); },
      getHeight(x: number, z: number) { const t = w.topAt(x, z); return t > 0 ? t : 0; },
    };
    const sim = new MoveSim(surf, simAt(0, 6 + H, 0, { onGround: false }));
    for (let i = 0; i < 60; i++) sim.update(1 / 30);
    // Grounded at the top face — the contact band settles ~0.2 above the
    // exact clamp, so assert the window rather than the millimeter.
    expect(sim.state.pos.y).toBeGreaterThan(3 + H - 0.05);
    expect(sim.state.pos.y).toBeLessThan(3 + H + 0.25);
    expect(sim.state.onGround).toBe(true);
  });

  test('knee-high ledge is a floor, not a blocker', () => {
    const w = SolidWorld.fromSpecs(lowStep);
    const s = simAt(10, 0.5 + H, 0); // feet at 0.5 — above top(0.4)-step(0.55)? 0.5 > -0.15 ✓ floor
    w.resolveBody(s);
    expect(s.pos.x).toBe(10); // no push-out
  });
});

describe('segSolidHit', () => {
  const cols = structureColliders(wall);

  test('a segment into the wall face reports the entry point', () => {
    const hit = segSolidHit({ x: 0, y: 3, z: 0 }, { x: 20, y: 3, z: 0 }, cols);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(9.5, 1); // face plane at x = 10 - 0.5
    expect(hit!.t).toBeGreaterThan(0);
    expect(hit!.t).toBeLessThan(1);
  });

  test('a segment clear of the wall misses', () => {
    expect(segSolidHit({ x: 0, y: 3, z: 8 }, { x: 20, y: 3, z: 8 }, cols)).toBeNull(); // past z extent
    expect(segSolidHit({ x: 0, y: 8, z: 0 }, { x: 20, y: 8, z: 0 }, cols)).toBeNull(); // over the 6m top
  });

  test('a segment starting inside reports entry at t=0', () => {
    const hit = segSolidHit({ x: 10, y: 3, z: 0 }, { x: 20, y: 3, z: 0 }, cols);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(0);
  });

  test('yaw-rotated walls still occlude along their real face', () => {
    const rotated = structureColliders([
      { kind: 'wall', pos: { x: 0, y: 0, z: 0 }, size: { x: 20, y: 6, z: 1 }, rotY: Math.PI / 4 },
    ]);
    // Ray along +x at z≈3 should cross the 45° wall's broad face.
    const hit = segSolidHit({ x: -10, y: 3, z: 3 }, { x: 10, y: 3, z: 3 }, rotated);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.x)).toBeLessThan(8); // entry before the wall centerline
  });
});
