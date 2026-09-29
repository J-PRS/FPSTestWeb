import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, firstPlayer, watch } from './harness.ts';

describe('scenario: deploy claims', () => {
  it('a claim plants a real deployable within reach, broadcasts deploySpawn', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    const w = watch(room);
    room.messages.handleMessage(p.id, { type: 'deploy', kind: 'turret', position: { x: 3, y: 31, z: 0 } });
    expect(w.count('deploySpawn')).toBe(1);
    const items = [...room.deployables['items'].values()] as { kind: string; owner: string }[];
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe('turret');
    expect(items[0]!.owner).toBe(p.id);
  });

  it('claims past the plant radius are silently dropped', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    const w = watch(room);
    room.messages.handleMessage(p.id, { type: 'deploy', kind: 'turret', position: { x: 400, y: 31, z: 0 } });
    expect(w.count('deploySpawn')).toBe(0);
    expect([...room.deployables['items'].values()].length).toBe(0);
  });

  it('per-kind cap recycles the oldest instead of refusing or piling up', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    const w = watch(room);
    // Two gates stack here: deploy is rate-limited to 4/s, and the
    // per-kind cap is 6 — claims 5+ die at the rate gate first.
    for (let i = 0; i < 7; i++) {
      room.messages.handleMessage(p.id, { type: 'deploy', kind: 'mine', position: { x: i + 1, y: 31, z: i } });
    }
    expect(w.count('deploySpawn')).toBe(4);
    // The recycle path itself lives below the rate gate — drive it directly:
    // claim 7 in one burst, cap keeps the pile at 6 with the oldest evicted.
    room.messages.handleMessage(p.id, { type: 'deploy', kind: 'turret', position: { x: 30, y: 31, z: 0 } }); // burns the rate window
    w.msgs.length = 0;
    for (let i = 0; i < 7; i++) {
      room.deployables.handleDeploy(p.id, 'mine', { x: 10 + i, y: 31, z: 0 });
    }
    const mines = [...room.deployables['items'].values()].filter((d) => d.owner === p.id && d.kind === 'mine');
    expect(mines.length).toBe(6);
  });

  it('an unknown kind and a dead claimer are both dropped', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    const w = watch(room);
    room.messages.handleMessage(p.id, { type: 'deploy', kind: 'orbital', position: { x: 1, y: 31, z: 0 } } as never);
    p.isDead = true;
    room.messages.handleMessage(p.id, { type: 'deploy', kind: 'turret', position: { x: 1, y: 31, z: 0 } });
    expect(w.count('deploySpawn')).toBe(0);
  });
});
