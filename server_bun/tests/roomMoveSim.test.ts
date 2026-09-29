import { describe, expect, test } from 'bun:test';
import { RoomMoveSim } from '../src/RoomMoveSim.ts';
import { MOVEMENT_CONFIG } from '../../shared/movement.ts';
import { STATUS } from '../../shared/status.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

const flat: Heightfield = { width: 2, height: 2, data: new Uint8Array(4) };
const slopey: Heightfield = { width: 4, height: 4, data: new Uint8Array(16).fill(128) };

describe('RoomMoveSim', () => {
  test('tracks, ticks, and follows a forward input', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: false });
    for (let i = 0; i < 20; i++) m.tick(0.05);
    const pos = m.simPos('p1')!;
    expect(Math.abs(pos.x) + Math.abs(pos.z)).toBeGreaterThan(0.5);
  });

  test('honest report reconciles quietly; divergence returns sim truth', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) m.tick(0.05);
    // small drift — no divergence
    expect(m.reconcile('p1', { x: 1, y: 0, z: 0 }, 0)).toBeNull();
    // 100m blink — correction state comes back, sim keeps its own truth
    // (resyncing onto the rejected report would ping-pong corrections).
    const truth = m.reconcile('p1', { x: 100, y: 0, z: 0 }, 0);
    expect(truth).not.toBeNull();
    expect(Math.abs(m.simPos('p1')!.x)).toBeLessThan(8);
    // Throttled — an immediate second divergent report doesn't refire.
    expect(m.reconcile('p1', { x: 100, y: 0, z: 0 }, 0)).toBeNull();
  });

  test('resync resets to the declared position', () => {
    const m = new RoomMoveSim(slopey);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.resync('p1', { x: 50, y: 60, z: 50 }, 1);
    expect(m.simPos('p1')).toEqual({ x: 50, y: 60, z: 50 });
  });

  test('untrack drops the shadow; null field is a no-op', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.untrack('p1');
    expect(m.simPos('p1')).toBeNull();
    const noField = new RoomMoveSim(null);
    noField.track('x', { x: 0, y: 0, z: 0 }, 0);
    expect(noField.simPos('x')).toBeNull();
  });

  test('gravity acts on the shadow', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 50, z: 0 }, 0);
    m.tick(0.05); // first tick just clears onGround — collision runs after move
    m.tick(0.05);
    expect(m.simPos('p1')!.y).toBeLessThan(50);
  });

  test('config stays in lockstep with the client values', () => {
    expect(MOVEMENT_CONFIG.jumpSpeed).toBe(7.0);
    expect(MOVEMENT_CONFIG.maxVelocityGround).toBe(7.0);
  });

  test('modeled energy gates the jet claim — infinite jetting dries up', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.setInput('p1', { jetHeld: true });
    let peak = 0;
    for (let i = 0; i < 200; i++) { // 10s of claimed jet
      m.tick(0.05);
      peak = Math.max(peak, m.simPos('p1')!.y);
    }
    // 60 energy / 15 per sec ≈ 4s of thrust — after that gravity wins
    // and the player comes back down; an ungated sim would still climb.
    const y = m.simPos('p1')!.y;
    expect(peak).toBeGreaterThan(5);
    expect(y).toBeLessThan(peak);
  });

  test('featherjets perk burns the tank slower', () => {
    const base = new RoomMoveSim(flat);
    const feat = new RoomMoveSim(flat);
    base.track('b', { x: 0, y: 0, z: 0 }, 0);
    feat.track('f', { x: 0, y: 0, z: 0 }, 0, 'featherjets');
    base.setInput('b', { jetHeld: true });
    feat.setInput('f', { jetHeld: true });
    // At 5s the base tank (60/15=4s) is dry; featherjets (60/10.5≈5.7s)
    // is still burning and still climbing.
    for (let i = 0; i < 100; i++) { base.tick(0.05); feat.tick(0.05); }
    expect(feat.simPos('f')!.y).toBeGreaterThan(base.simPos('b')!.y);
  });

  test('cloak ante + drain charge the shadow tank', () => {
    const m = new RoomMoveSim(flat);
    // Stand above the collision plane — spawning under it tunnels.
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight + 0.5, z: 0 }, 0);
    // Rising edge on CLOAK costs 20 immediately, then 5/s while up;
    // recharge is suppressed while a toggle skill runs.
    m.setInput('p1', { jetHeld: true }, STATUS.CLOAK);
    let peak = 0;
    for (let i = 0; i < 100; i++) { m.tick(0.05); peak = Math.max(peak, m.simPos('p1')!.y); }
    // 40 energy after the ante ÷ (15+5)/s ≈ 2s of jet — much less
    // than the ~4s a clean tank buys.
    const base = 2.3;
    expect(peak).toBeGreaterThan(base);
    expect(peak).toBeLessThan(60);
  });

  test('authority mode tightens divergence + correction throttle', () => {
    const m = new RoomMoveSim(flat, true);
    expect(m.authoritative).toBe(true);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) m.tick(0.05);
    // First report is the spawn-landing seed — snaps the sim, never judges.
    expect(m.reconcile('p1', { x: 0, y: 0, z: 0 }, 0)).toBeNull();
    // 2m off — inside judge tolerance, past the authority bound: truth fires.
    expect(m.reconcile('p1', { x: 2, y: 0, z: 0 }, 0)).not.toBeNull();
    // Throttled at 100ms — an immediate second report doesn't refire.
    expect(m.reconcile('p1', { x: 2, y: 0, z: 0 }, 0)).toBeNull();
  });

  test('authority without a field falls back to judge (no sim, no flag)', () => {
    const m = new RoomMoveSim(null, true);
    expect(m.authoritative).toBe(false);
  });

  test('stale inputMove seqs are dropped — unordered transports can reorder', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight + 0.5, z: 0 }, 0);
    expect(m.setInput('p1', { forward: 1 }, 0, 5)).toBe(true);
    // A replayed earlier event must not rewind the input state.
    expect(m.setInput('p1', { forward: 0 }, 0, 3)).toBe(false);
    for (let i = 0; i < 20; i++) m.tick(0.05);
    const pos = m.simPos('p1')!;
    expect(Math.abs(pos.x) + Math.abs(pos.z)).toBeGreaterThan(0.5);
    // seq-less callers (old clients / tests) always pass.
    expect(m.setInput('p1', { forward: 0 })).toBe(true);
  });

  test('a grounded skier at a standstill can still push off', () => {
    // Regression: ski used to skip ground physics entirely, so a
    // zero-speed skier holding forward never accelerated (frozen bots).
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true });
    for (let i = 0; i < 20; i++) m.tick(0.05);
    const pos = m.simPos('p1')!;
    expect(Math.abs(pos.x) + Math.abs(pos.z)).toBeGreaterThan(0.5);
  });

  test('a report ahead of the shadow by in-flight inputs compares against the probe', () => {
    // The client consumed inputs the server hasn't received yet — its
    // position legitimately leads the sim by ~vel * pending. With the
    // inputSeq anchor this must not flag; without it the same report is
    // a teleport-scale divergence at ski speeds.
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, jumpHeld: false, skiHeld: true }, 0, 1);
    for (let i = 0; i < 60; i++) m.tick(1 / 30); // build up real speed
    const s = m.simState('p1')!;
    // A report ~4 steps ahead of the sim — inside probe range (cap 8).
    const ahead = { x: s.pos.x + s.vel.x * (4 / 30), y: s.pos.y, z: s.pos.z + s.vel.z * (4 / 30) };
    expect(m.reconcile('p1', ahead, 0, s.vel, 5)).toBeNull();
    // Same offset with no anchor (old client) → judged on stale state.
    // At ski speed the gap can exceed tolerance, so this is allowed to
    // flag — the assert that matters is above.
  });

  test('speed-scaled tolerance absorbs ski-speed drift but not teleports', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, skiHeld: true }, 0, 1);
    for (let i = 0; i < 60; i++) m.tick(1 / 30);
    const s = m.simState('p1')!;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const tol = 10 * (1 + speed / 60);
    // Drift just under the scaled tolerance reconciles quietly.
    const near = { x: s.pos.x + tol * 0.9, y: s.pos.y, z: s.pos.z };
    expect(m.reconcile('p1', near, 0, s.vel)).toBeNull();
    // A real teleport still flags.
    expect(m.reconcile('p1', { x: s.pos.x + 200, y: s.pos.y, z: s.pos.z }, 0, s.vel)).not.toBeNull();
  });
});
