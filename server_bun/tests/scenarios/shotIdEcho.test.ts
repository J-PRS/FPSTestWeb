import { describe, it, expect } from 'bun:test';
import { mkRoom, watch, twoPlayers, step, freeze } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// The parity ledger keys the server shell's fate on the intent nonce —
// if projectileDestroyed ever ships without shotId, every damage echo
// reads srvAt:"none" and the intent-loss/trajectory split goes dark.
describe('scenario: shotId echoes', () => {
  it('gone edge carries the intent nonce end to end', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 62, z: 0 });
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: -0.5, z: 0 }, pos: { x: 0, y: 62, z: 0 },
      weaponType: WeaponType.Disc, shotId: 's42',
    } as never);
    step(room, 60); // disc arcs down and dies — the gone edge must fire
    const gones = w.msgs.filter((m): m is Extract<ServerMessage, { type: 'projectileDestroyed' }> => m.type === 'projectileDestroyed');
    expect(gones.length).toBeGreaterThanOrEqual(1);
    expect(gones[0]!.shotId).toBe('s42');
    expect(gones[0]!.position).toBeTruthy();
  });
});
