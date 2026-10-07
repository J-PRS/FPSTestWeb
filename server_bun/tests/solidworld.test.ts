import { describe, expect, test } from 'bun:test';
import { ColliderIndex, SolidWorld, blastOccluded, segSolidHit } from '../../shared/solidWorld.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import { FieldSurface } from '../../shared/fieldSurface.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { MoveSim, MOVEMENT_CONFIG, type MoveState } from '../../shared/movement.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import type { Vec3Like } from '../../shared/movement.ts';

const H = MOVEMENT_CONFIG.playerHeight; // pos.y is capsule top

// Flat plain at y=0 — the solid layer alone decides contact outcomes.
const flat = { getHeight: () => 0, getNormal: (_x: number, _z: number, out: Vec3Like) => { out.x = 0; out.y = 1; out.z = 0; return out; } };

// Real FieldSurface over a flat heightfield — the compositor the game
// actually runs, so reach-limited floors are exercised end to end.
const flatField: Heightfield = { size: 4, data: new Uint8Array(64 * 64), stride: 64 };
const fieldSurf = (specs: StructureSpec[]): FieldSurface => {
  const s = FieldSurface.fromField(flatField);
  s.solid = SolidWorld.fromSpecs(specs);
  return s;
};

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

  test('MoveSim: walking under a floating deck never snaps onto it', () => {
    const deck: StructureSpec[] = [
      { kind: 'box', pos: { x: 10, y: 2.5, z: 0 }, size: { x: 4, y: 5, z: 4 } }, // spans y 2.5–7.5
    ];
    const sim = new MoveSim(fieldSurf(deck), simAt(4, H, 0));
    sim.setInput({ forward: 1 });
    sim.state.yaw = Math.PI / 2;
    for (let i = 0; i < 240; i++) sim.update(1 / 60);
    expect(sim.state.pos.x).toBeGreaterThan(12); // walked through under the deck
    expect(sim.state.pos.y).toBeCloseTo(H, 1);   // stayed on the terrain — no up-snap
  });

  test('MoveSim: a tall wall blocks horizontally through the real surface', () => {
    const tall: StructureSpec[] = [
      { kind: 'box', pos: { x: 10, y: 0, z: 0 }, size: { x: 4, y: 5, z: 4 } },
    ];
    const sim = new MoveSim(fieldSurf(tall), simAt(4, H, 0));
    sim.setInput({ forward: 1 });
    sim.state.yaw = Math.PI / 2;
    for (let i = 0; i < 240; i++) sim.update(1 / 60);
    expect(sim.state.pos.x).toBeLessThan(8);     // face at 8 minus capsule radius
    expect(sim.state.pos.y).toBeCloseTo(H, 1);   // never teleported to the top
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


const obox = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotY = 0): StructureCollider => ({
  cx, cy, cz, hx, hy, hz, cos: Math.cos(rotY), sin: Math.sin(rotY),
});
const BIGWALL = [obox(5, 1, 0, 1, 2, 5)];      // x∈[4,6], z∈[-5,5], y∈[-1,3]

describe('ColliderIndex', () => {
  test('queries return only nearby boxes — pruning, not skipping', () => {
    const far = obox(500, 0, 500, 2, 2, 2);
    const idx = new ColliderIndex([...BIGWALL, far]);
    const out: StructureCollider[] = [];
    idx.queryPoint(0, 0, 1, out);
    expect(out).not.toContain(far);
    idx.queryPoint(5, 0, 1, out);
    expect(out).toContain(BIGWALL[0]!);
  });

  test('indexed segSolidHit answers identically to the linear scan', () => {
    const idx = new ColliderIndex(BIGWALL);
    const a = segSolidHit({ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }, BIGWALL);
    const b = segSolidHit({ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }, BIGWALL, idx);
    expect(b).toEqual(a);
  });
});

describe('blastOccluded', () => {
  test('wall between blast and chest blocks the blast', () => {
    expect(blastOccluded({ x: 0, y: 1, z: 0 }, { x: 10, y: 0, z: 0 }, BIGWALL)).toBe(true);
  });

  test('clear line → not occluded', () => {
    expect(blastOccluded({ x: 0, y: 1, z: 0 }, { x: -10, y: 0, z: 0 }, BIGWALL)).toBe(false);
  });

  test('blast inside the box hops past instead of occluding same-side targets', () => {
    expect(blastOccluded({ x: 4.05, y: 1, z: 0 }, { x: -5, y: 0, z: 0 }, BIGWALL)).toBe(false);
  });
});

describe('SolidWorld extras', () => {
  const mkBody = (x: number, top: number, z: number): MoveState =>
    ({ pos: { x, y: top, z }, vel: { x: 5, y: 0, z: 0 } }) as MoveState;

  test('velocity into a face is killed; tangential slide stays free', () => {
    const w = new SolidWorld(BIGWALL);
    const s = mkBody(3.7, 1 + H, 0); // capsule nose inside the face
    s.vel.x = 6;   // into the wall
    s.vel.z = 3;   // sliding along it
    w.resolveBody(s);
    expect(s.vel.z).toBeCloseTo(3, 5);
    expect(s.vel.x).toBeLessThanOrEqual(0);
  });

  test('head under a box underside drops out and kills upward motion', () => {
    const ceiling = [obox(0, 3, 0, 3, 1, 3)]; // bot=2, top=4
    const w = new SolidWorld(ceiling);
    const s = mkBody(0, 2.2, 0);
    s.vel.y = 8;
    w.resolveBody(s);
    expect(s.pos.y).toBeLessThanOrEqual(2);
    expect(s.vel.y).toBe(0);
  });
});
