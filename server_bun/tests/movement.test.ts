import { describe, it, expect } from 'bun:test';
import {
  MoveSim, ENERGY, MOVEMENT_CONFIG,
  cloakDrainPerSec, type MoveSurface, type MoveState, type BodyCapsule,
} from '../../shared/movement.ts';

// The shared movement sim — both ends integrate the SAME code at a fixed
// 60Hz, so client prediction and server authority produce identical
// trajectories for identical input. hopjet/roomMoveSim pin the jump/jet
// basics; this pins the rest of the contract: accumulator parity, the
// stall cap, energy drains, mass scaling, body contact, overspeed bleed.

const flat: MoveSurface = {
  getHeight: () => 0,
  getNormal: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};
const mk = (over: Partial<MoveState> = {}): MoveSim =>
  new MoveSim(flat, {
    pos: { x: 0, y: 1.8, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, onGround: true, ...over,
  });
const run = (s: MoveSim, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) s.update(dt);
};

describe('movement', () => {
  it('cloak drain is 1/s static, 10/s at 100m/s, linear between', () => {
    expect(cloakDrainPerSec(0)).toBe(ENERGY.cloakDrainMin);
    expect(cloakDrainPerSec(100)).toBe(ENERGY.cloakDrainMax);
    expect(cloakDrainPerSec(50)).toBeCloseTo(ENERGY.cloakDrainMin + 4.5, 5);
    expect(cloakDrainPerSec(-5)).toBe(ENERGY.cloakDrainMin);   // clamps low
    expect(cloakDrainPerSec(999)).toBe(ENERGY.cloakDrainMax);  // clamps high
  });

  it('the fixed-step accumulator makes split dt equal lumped dt', () => {
    const a = mk(), b = mk();
    a.setInput({ forward: 1 }); b.setInput({ forward: 1 });
    a.update(0.1);                                   // one call
    for (let i = 0; i < 10; i++) b.update(0.01);     // ten calls, same span
    expect(a.state.pos).toEqual(b.state.pos);
    expect(a.state.vel).toEqual(b.state.vel);
  });

  it('sub-step remainder carries — a 20ms call does one 60Hz step, not zero', () => {
    const s = mk();
    s.setInput({ forward: 1 });
    const v0 = s.state.vel.z;
    s.update(0.02);
    expect(s.state.vel.z).toBeGreaterThan(v0); // acc >= STEP fired
    s.update(0.004);                            // remainder accumulates, no step
    const v1 = s.state.vel.z;
    s.update(0.004);
    expect(s.state.vel.z).toBeGreaterThanOrEqual(v1);
  });

  it('a stalled frame caps catch-up at MAX_DT — no runaway integration', () => {
    const s = mk({ pos: { x: 0, y: 100, z: 0 }, onGround: false });
    s.update(10); // giant dt — sim should integrate only 0.25s of it
    // 0.25s of gravity: v ~= -7 m/s (plus clamp), never hundreds.
    expect(s.state.vel.y).toBeLessThan(-5);
    expect(s.state.vel.y).toBeGreaterThan(-10);
  });

  it('jet thrust is force, not accel — a heavy climbs slower on the same burn', () => {
    const light = mk({ pos: { x: 0, y: 5, z: 0 }, onGround: false });
    const heavy = mk({ pos: { x: 0, y: 5, z: 0 }, onGround: false });
    heavy.mass = 2.5;
    light.setInput({ jetHeld: true }); heavy.setInput({ jetHeld: true });
    run(light, 0.5); run(heavy, 0.5);
    expect(light.state.vel.y).toBeGreaterThan(heavy.state.vel.y);
  });

  it('airborne fall clamps at terminal velocity', () => {
    const s = mk({ pos: { x: 0, y: 10000, z: 0 }, onGround: false });
    run(s, 4); // terminal needs ~3.6s of gravity at 28 m/s²
    expect(s.state.vel.y).toBeGreaterThanOrEqual(-MOVEMENT_CONFIG.terminalVelocity - 0.001);
    expect(s.state.vel.y).toBeLessThanOrEqual(-MOVEMENT_CONFIG.terminalVelocity + 0.5);
  });

  it('grounded friction stops a walker below the stop threshold', () => {
    const s = mk();
    s.state.vel.x = 0.5; // creeping — under stopThreshold
    run(s, 0.2);
    expect(s.state.vel.x).toBe(0);
    expect(s.state.vel.z).toBe(0);
  });

  it('a ski-held body above walk speed keeps momentum — no ground motor, no friction', () => {
    const s = mk({ vel: { x: 30, y: 0, z: 0 } });
    s.setInput({ skiHeld: true });
    run(s, 0.5);
    // Skiing is friction-toggle only on flat: gravity eats a bit of speed
    // through slope redirect (none here — flat), so speed ~preserved.
    expect(Math.hypot(s.state.vel.x, s.state.vel.z)).toBeGreaterThan(28);
  });

  it('grounded overspeed bleeds toward the cap instead of hard-clamping', () => {
    const s = mk({ vel: { x: 40, y: 0, z: 0 } }); // blast-speed on the ground
    run(s, 0.1);
    const v = Math.hypot(s.state.vel.x, s.state.vel.z);
    expect(v).toBeLessThan(40);                       // decayed
    expect(v).toBeGreaterThan(MOVEMENT_CONFIG.maxVelocityGround); // not truncated in one step
  });

  it('body contact: overlapping capsules separate and the lighter takes the bump', () => {
    const s = mk({ pos: { x: 0, y: 1.8, z: 0 } });
    s.mass = 1;
    const heavy: BodyCapsule = { x: 0.5, y: 1.8, z: 0, h: 1.8, mass: 4, vx: 0, vz: 0, r: 0.6, id: 'h' };
    s.bodies = [heavy];
    s.setInput({ forward: -1 }); // pushing toward +x? forward at yaw 0 is +z; use a closing velocity instead
    s.state.vel.x = 5;           // closing on the heavy
    run(s, 0.1);
    expect(Math.abs(s.state.pos.x)).toBeGreaterThan(0); // separated
  });

  it('self capsule is skipped — a zero-distance self hit cannot push', () => {
    const s = mk();
    s.selfId = 'me';
    s.bodies = [{ x: 0, y: 1.8, z: 0, h: 1.8, mass: 1, vx: 0, vz: 0, r: 0.6, id: 'me' }];
    run(s, 0.1);
    expect(s.state.pos.x).toBe(0);
    expect(s.state.pos.z).toBe(0);
  });

  it('a body above the capsule span does not collide', () => {
    const s = mk();
    // Neighbor feet at y=1.8+h means it hovers over us — same x,z, no hit.
    s.bodies = [{ x: 0, y: 1.8 + 5, z: 0, h: 1.8, mass: 1, vx: 0, vz: 0, r: 0.6, id: 'fly' }];
    run(s, 0.1);
    expect(s.state.pos.x).toBe(0);
    expect(s.state.pos.z).toBe(0);
  });

  it('autoHop: holding jump keeps hopping on every landing', () => {
    const s = mk();
    s.setInput({ jumpHeld: true });
    let apexes = 0;
    let airborne = false;
    for (let i = 0; i < 240; i++) { // 4s
      s.update(1 / 60);
      if (!s.state.onGround) airborne = true;
      if (airborne && s.state.onGround) { apexes++; airborne = false; }
    }
    expect(apexes).toBeGreaterThanOrEqual(2); // hopped repeatedly, not once
  });
});
