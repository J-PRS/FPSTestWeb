import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers, watch } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Melee is a skill, not a projectile — the swing rides the shotFired
// intent and the server derives the arc point itself; a claim that still
// names a swing position is forged (claimsAccepted: false on a Room that
// sims every outcome).
describe('scenario: melee AOE claims', () => {
  it('a swing inside the band damages the target through the funnel', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 3, y: 31, z: 0 });
    const w = watch(room);
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', weaponType: 10 /* Melee */, dir: { x: 1, y: 0, z: 0 },
    } as never);
    expect(b.health).toBeLessThan(hp);
    expect(w.count('playerHit')).toBeGreaterThan(0);
  });

  it('a forged aoeShot swing claim is refused — no damage at all', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 3, y: 31, z: 0 });
    const sent: ServerMessage[] = [];
    room.connections.register(a.id, {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { sent.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'aoeShot', weaponType: 10 /* Melee */, position: { x: 2, y: 31, z: 0 }, claimSeq: 7,
    } as never);
    // The verb still decodes, but the sim-running authority never
    // adjudicates claims — the stamp comes back as a refused ack.
    expect(b.health).toBe(hp);
    expect(sent.some((m) => m.type === 'claimAck' && (m as { ok?: boolean }).ok === false)).toBe(true);
  });
});
