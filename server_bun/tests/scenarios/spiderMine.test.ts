import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';

describe('scenario: spider mine', () => {
  // Ground-bound hunter: arms, crawls to a grounded hostile, detonates
  // and is spent. An airborne body is never a target - air is the
  // counter by design.
  it('crawls to a grounded hostile and detonates, consuming itself', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    pin(room, 'engi', { x: 0, y: 30, z: 0 });
    room.players.getPlayer('engi')!.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'spider', { x: 5, y: 30, z: 0 })).toBe(true);
    const items = (room.deployables as unknown as { items: Map<number, { id: number; pos: { x: number; y: number; z: number } }> }).items;
    const d = [...items.values()][0]!;
    room.players.addPlayer('prey', 'bravo', 'none', 'medium');
    room.moveSim.track('prey', { x: d.pos.x + 8, y: d.pos.y, z: d.pos.z }, 0, undefined, 'bravo');
    pin(room, 'prey', { x: d.pos.x + 8, y: d.pos.y, z: d.pos.z });
    const hp0 = room.players.getPlayer('prey')!.health;
    step(room, 10);
    expect(items.has(d.id)).toBe(true);
    step(room, 80); // crawl 8m at 14 m/s + detonation
    expect(items.has(d.id)).toBe(false);
    expect(room.players.getPlayer('prey')!.health).toBeLessThan(hp0);
  });

  it('a flying body never trips it - air is the counter', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    pin(room, 'engi', { x: 0, y: 30, z: 0 });
    room.players.getPlayer('engi')!.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'spider', { x: 5, y: 30, z: 0 })).toBe(true);
    const items = (room.deployables as unknown as { items: Map<number, { id: number; pos: { x: number; y: number; z: number } }> }).items;
    const d = [...items.values()][0]!;
    const x0 = d.pos.x;
    room.players.addPlayer('flyer', 'bravo', 'none', 'medium');
    // Pin the body 40m up, directly over the spider - no ground, no trip.
    room.moveSim.track('flyer', { x: d.pos.x, y: d.pos.y + 40, z: d.pos.z }, 0, undefined, 'bravo');
    pin(room, 'flyer', { x: d.pos.x, y: d.pos.y + 40, z: d.pos.z });
    step(room, 60);
    expect(items.has(d.id)).toBe(true);
    expect(d.pos.x).toBeCloseTo(x0, 3); // never chased
  });
});
