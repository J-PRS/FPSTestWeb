import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, firstPlayer } from './harness.ts';
import { ENERGY } from '../../../shared/movement.ts';

describe('scenario: skill energy on the shadow sim', () => {
  it('claiming cloak pays the activation ante, then drains while held', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.moveSim.track(p.id, p.position, 0, p.perk);
    expect(room.moveSim.energyOf(p.id)).toBe(ENERGY.max);

    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 1,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 4 /* CLOAK */ },
    });
    // Rising edge pays the ante immediately — a fresh claim can't be free.
    expect(room.moveSim.energyOf(p.id)!).toBe(ENERGY.max - ENERGY.cloakCost);
    const afterAnte = room.moveSim.energyOf(p.id)!;

    // Held cloak burns the drain rate per sim-tick; regen is suppressed
    // while any skill drain is active.
    room.moveSim.tick(1.0);
    expect(room.moveSim.energyOf(p.id)!).toBeCloseTo(afterAnte - ENERGY.cloakDrain, 5);

    // Drop the bit: drain stops and the tank refills.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 2,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 },
    });
    const before = room.moveSim.energyOf(p.id)!;
    room.moveSim.tick(1.0);
    expect(room.moveSim.energyOf(p.id)!).toBeGreaterThan(before);
  });

  it('re-claiming at empty still pays ante — energy can go to the floor but the bit is client-owned', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.moveSim.track(p.id, p.position, 0, p.perk);
    room.moveSim.drainEnergy(p.id, ENERGY.max - 5); // near-empty tank
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 1,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 4 },
    });
    expect(room.moveSim.energyOf(p.id)).toBe(0); // ante floored at zero, never negative
  });
});
