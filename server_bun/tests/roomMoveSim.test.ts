import { describe, expect, test } from 'bun:test';
import { RoomMoveSim } from '../src/RoomMoveSim.ts';
import { MOVEMENT_CONFIG } from '../../shared/movement.ts';
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

  test('honest report reconciles quietly; teleport diverges and resyncs', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) m.tick(0.05);
    // small drift — no divergence
    m.reconcile('p1', { x: 1, y: 0, z: 0 }, 0);
    expect(m.simPos('p1')!.x).toBeLessThan(8);
    // 100m blink — counted + resynced to the report
    m.reconcile('p1', { x: 100, y: 0, z: 0 }, 0);
    expect(m.simPos('p1')!.x).toBe(100);
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
});
