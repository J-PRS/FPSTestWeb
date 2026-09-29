import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers, watch } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Melee is a skill, not a projectile — the swing point must sit inside
// the band in front of the swinger; beyond it the claim is forged.
describe('scenario: melee AOE claims', () => {
  it('a swing inside the band damages the target through the funnel', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 3, y: 31, z: 0 });
    const w = watch(room);
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'aoeShot', weaponType: 10 /* Melee */, position: { x: 2, y: 31, z: 0 },
    } as never);
    expect(b.health).toBeLessThan(hp);
    expect(w.count('playerHit')).toBeGreaterThan(0);
  });

  it('a swing point teleporting past the band is rejected, no damage', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 60, y: 31, z: 60 });
    const sent: ServerMessage[] = [];
    room.connections.register(a.id, {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { sent.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);
    room.messages.handleMessage(a.id, {
      type: 'aoeShot', weaponType: 10 /* Melee */, position: { x: 60, y: 31, z: 60 },
    } as never);
    expect(b.health).toBeGreaterThanOrEqual(100);
    expect(sent.some((m) => m.type === 'shotRejected')).toBe(true);
  });
});
