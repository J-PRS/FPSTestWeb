import { describe, it, expect } from 'bun:test';
import { structureColliders, collideStructures, BALL_BOUNCE } from '../../shared/ballCollide.ts';
import { makeSimBall, BALL_BASE_RADIUS } from '../../shared/ballSim.ts';

// The shared sphere-vs-structure solver — server authority and client
// replay step this identically; a behavioral change here IS a desync.
// Variant 0 radius = BALL_BASE_RADIUS (1.2).
const R = BALL_BASE_RADIUS;

function ball(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0) {
  return makeSimBall(1, 0, 0, { x, y, z }, { x: vx, y: vy, z: vz });
}
const BOX = { kind: 'box' as const, pos: { x: 0, y: 0, z: 0 }, size: { x: 10, y: 2, z: 10 } };
// collider: center (0,1,0), half (5,1,5) → top face at y=2, sphere rests at 3.2
const REST_Y = 2 + R;

describe('structureColliders — spec to yaw-OBB', () => {
  it('box pieces center at pos.y + size.y/2', () => {
    const [c] = structureColliders([{ kind: 'box', pos: { x: 10, y: 0, z: 20 }, size: { x: 4, y: 6, z: 8 } }]);
    expect(c).toMatchObject({ cx: 10, cy: 3, cz: 20, hx: 2, hy: 3, hz: 4 });
  });

  it('root pieces collide as two feet — the arch span stays open', () => {
    const cols = structureColliders([{ kind: 'root', pos: { x: 0, y: 0, z: 0 }, size: { x: 5, y: 1, z: 1 } }]);
    expect(cols).toHaveLength(2);
    expect(cols[0]!.cx).toBe(-5);
    expect(cols[1]!.cx).toBe(5);
    expect(cols[0]!.hx).toBe(1);
    expect(cols[0]!.hy).toBe(2.5);
  });

  it('kit scale multiplies hull centers and extents', () => {
    // Scaled ×2 must double BOTH the hull's offset from the piece base
    // and its half-extents, or the visual (uniform scale) and collision
    // drift apart.
    const SZ = { x: 1, y: 1, z: 1 }; // ignored for kits, still required
    const a = structureColliders([{ kind: 'kit', piece: 'bastion', pos: { x: 100, y: 0, z: 0 }, size: SZ, scale: 2 }])[0]!;
    const b = structureColliders([{ kind: 'kit', piece: 'bastion', pos: { x: 100, y: 0, z: 0 }, size: SZ }])[0]!;
    expect(a.hx).toBeCloseTo(b.hx * 2);
    expect(a.cy).toBeCloseTo(b.cy * 2); // local-space cy doubles around the base
    expect(a.cx - 100).toBeCloseTo((b.cx - 100) * 2);
    const c = structureColliders([{ kind: 'kit', piece: 'pillar', pos: { x: 0, y: 0, z: 0 }, size: SZ, rotY: Math.PI / 2, scale: 2 }])[0]!;
    expect(Math.abs(c.cx)).toBeCloseTo(0); // pillar hull sits on the axis
  });
});

describe('collideStructures — push-out + elastic reflect', () => {
  it('a sphere grazing a face is pushed to contact distance and reflects', () => {
    const cols = structureColliders([BOX]);
    const b = ball(0, REST_Y - 0.1, 0, 0, -5, 0); // 0.1 into the top face, falling
    expect(collideStructures(b, cols)).toBe(true);
    expect(b.y).toBeCloseTo(REST_Y, 9);
    expect(b.vy).toBeCloseTo(5 * BALL_BOUNCE, 9);
    expect(b.vx).toBe(0);
  });

  it('a tangential mover still pushes out but keeps its velocity', () => {
    const cols = structureColliders([BOX]);
    const b = ball(0, REST_Y - 0.1, 0, 8, 0, 0);
    expect(collideStructures(b, cols)).toBe(true);
    expect(b.y).toBeCloseTo(REST_Y, 9);
    expect(b.vx).toBe(8); // dot >= 0 → no reflection
  });

  it('a center inside the box exits along the least-penetration axis', () => {
    const cols = structureColliders([BOX]);
    const b = ball(0.2, 1.1, 0.1, 0, 0, 0); // inside, just above center — top face nearest
    expect(collideStructures(b, cols)).toBe(true);
    expect(b.y).toBeCloseTo(REST_Y, 9); // exited upward to contact distance
    expect(b.x).toBeCloseTo(0.2, 9); // not sideways
    expect(b.z).toBeCloseTo(0.1, 9);
  });

  it('below-center inside exits downward — the nearer face wins', () => {
    const cols = structureColliders([BOX]);
    const b = ball(0, 0.9, 0, 0, 0, 0); // inside, just below center — bottom face nearest
    expect(collideStructures(b, cols)).toBe(true);
    expect(b.y).toBeCloseTo(0 - R, 9); // pushed to contact under the box
  });

  it('a clear miss leaves the ball untouched', () => {
    const cols = structureColliders([BOX]);
    const b = ball(50, 50, 50, 1, 1, 1);
    expect(collideStructures(b, cols)).toBe(false);
    expect({ x: b.x, y: b.y, z: b.z, vx: b.vx }).toEqual({ x: 50, y: 50, z: 50, vx: 1 });
  });

  it('yaw rotation turns the contact face — world +z hits the rotated x-face', () => {
    // rotY=90° maps world +z to local +x → the hx=5 face, not hz=1.
    const cols = structureColliders([{ kind: 'box', pos: { x: 0, y: 0, z: 0 }, size: { x: 10, y: 2, z: 2 }, rotY: Math.PI / 2 }]);
    const b = ball(0, 1, 5 + R - 0.1, 0, 0, -5); // approaching along world -z
    expect(collideStructures(b, cols)).toBe(true);
    expect(b.z).toBeCloseTo(5 + R, 9); // pushed out to contact on the x-face
    expect(b.vz).toBeCloseTo(5, 9);
  });

  it('the index query narrows candidates without changing the result', () => {
    const cols = structureColliders([BOX, { kind: 'box', pos: { x: 100, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } }]);
    const index = { queryPoint: (_x: number, _z: number, _p: number, out: typeof cols) => { out.push(cols[0]!); } };
    const b = ball(0, REST_Y - 0.1, 0, 0, -5, 0);
    expect(collideStructures(b, cols, index)).toBe(true);
    expect(b.y).toBeCloseTo(REST_Y, 9);
  });
});
