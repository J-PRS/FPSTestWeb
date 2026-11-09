import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

function wsSpy(room: ReturnType<typeof mkRoom>, pid: string): ServerMessage[] {
  const got: ServerMessage[] = [];
  room.connections.register(pid, {
    readyState: 1,
    send: (d: string | ArrayBuffer | Uint8Array) => { got.push(JSON.parse(d as string) as ServerMessage); return 0; },
  } as never);
  return got;
}

describe('scenario: shotFired cosmetic relay', () => {
  it('fire notifies everyone but the shooter, throttled to one per 50ms', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    a.armorClass = 'light'; // weaponType 12 (Lightning) is light-tier - the class-lock gate refuses medium/heavy
    const toA = wsSpy(room, a.id);
    const toB = wsSpy(room, b.id);

    room.messages.handleMessage(a.id, { type: 'shotFired', weaponType: 12, dir: { x: 1, y: 0, z: 0 } });
    expect(toA.length).toBe(0); // shooter already rendered their own muzzle
    expect(toB.filter((m) => m.type === 'playerShot').length).toBe(1);

    // Second notify inside the 50ms window is dropped — a flood of
    // fire-relays can't spam the room.
    room.messages.handleMessage(a.id, { type: 'shotFired', weaponType: 12, dir: { x: 1, y: 0, z: 0 } });
    expect(toB.filter((m) => m.type === 'playerShot').length).toBe(1);

    // Dead shooter relays nothing.
    a.isDead = true;
    room.messages.handleMessage(a.id, { type: 'shotFired', weaponType: 12, dir: { x: 1, y: 0, z: 0 } });
    expect(toB.filter((m) => m.type === 'playerShot').length).toBe(1);
  });
});
