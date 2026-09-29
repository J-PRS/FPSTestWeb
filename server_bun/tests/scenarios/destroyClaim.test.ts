import { describe, it, expect } from 'bun:test';
import { mkRoom, freeze, watch, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: projectileDestroy ownership', () => {
  it('a rival cannot delete your shell; only the owner can', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 40, y: 31, z: 0 });

    // A fires a miss — server registers the projectile and assigns its id.
    room.messages.handleMessage(a.id, {
      type: 'shot',
      targetId: null,
      position: { x: 1, y: 32, z: 0 },
      velocity: { x: 30, y: 0, z: 0 },
      weaponType: 2,
    });
    const created = w.msgs.find((m: ServerMessage) => m.type === 'projectileCreated');
    expect(created).toBeTruthy();
    const projId = (created as { projectileId: string }).projectileId;

    // B tries to snipe A's shell out of the air — must be silently refused.
    room.messages.handleMessage(b.id, { type: 'projectileDestroy', projectileId: projId });
    expect(w.count('projectileDestroyed')).toBe(0);

    // A's own destroy goes through and broadcasts once.
    room.messages.handleMessage(a.id, { type: 'projectileDestroy', projectileId: projId });
    expect(w.count('projectileDestroyed')).toBe(1);
  });
});
