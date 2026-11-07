import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';

describe('scenario: loiter munition', () => {
  // Plant, arm ~1s, hostile inside the dive ring commits the dive; the
  // powered line detonates on proximity and the item is spent. A
  // friendly in the same ring never trips it.
  it('arms, dives a hostile in the ring, and is consumed by the blast', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    pin(room, 'engi', { x: 0, y: 30, z: 0 });
    room.players.getPlayer('engi')!.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'loiter', { x: 5, y: 30, z: 0 })).toBe(true);
    const items = (room.deployables as unknown as { items: Map<number, { pos: { x: number; y: number; z: number }; loiterDive?: unknown }> }).items;
    const d = [...items.values()][0]!;
    room.players.addPlayer('prey', 'bravo', 'none', 'medium');
    room.moveSim.track('prey', { x: d.pos.x + 6, y: d.pos.y, z: d.pos.z }, 0, undefined, 'bravo');
    pin(room, 'prey', { x: d.pos.x + 6, y: d.pos.y, z: d.pos.z });
    const hp0 = room.players.getPlayer('prey')!.health;
    step(room, 10); // 0.5s - arming, hover only
    expect(d.loiterDive).toBeUndefined();
    step(room, 80); // commit + dive + detonate (42 m/s over ~10m)
    expect(items.has(d.pos ? (d as { id: number }).id : 0)).toBe(false);
    expect(room.players.getPlayer('prey')!.health).toBeLessThan(hp0);
  });

  it('ignores its own team loitering in the same ring', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    pin(room, 'engi', { x: 0, y: 30, z: 0 });
    room.players.getPlayer('engi')!.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'loiter', { x: 5, y: 30, z: 0 })).toBe(true);
    const items = (room.deployables as unknown as { items: Map<number, { id: number; pos: { x: number; y: number; z: number }; loiterDive?: unknown }> }).items;
    const d = [...items.values()][0]!;
    room.players.addPlayer('mate', 'alpha', 'none', 'medium');
    room.moveSim.track('mate', { x: d.pos.x + 5, y: d.pos.y, z: d.pos.z }, 0, undefined, 'alpha');
    pin(room, 'mate', { x: d.pos.x + 5, y: d.pos.y, z: d.pos.z });
    step(room, 60); // well past the arm - a teammate never commits it
    expect(d.loiterDive).toBeUndefined();
    expect(items.has(d.id)).toBe(true);
  });
});
