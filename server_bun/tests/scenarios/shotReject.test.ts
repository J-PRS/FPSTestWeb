import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: hit-claim validation', () => {
  it('a shot claim that geometrically cannot connect is rejected, not trusted', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 80, y: 31, z: 0 });

    // A fires a real miss northward so a ledger entry exists to reference.
    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: null,
      position: { x: 1, y: 32, z: 0 },
      velocity: { x: 30, y: 0, z: 0 },
      weaponType: 2,
    });
    const created = w.msgs.find((m: ServerMessage) => m.type === 'projectileCreated');
    const projId = (created as { projectileId: string }).projectileId;
    const hpBefore = room.players.getPlayer(b.id)!.health;
    // Rejections are private feedback to the shooter, not a broadcast.
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };

    // Now claim that same projectile "hit" B 200m below the ground —
    // geometric nonsense the server must refuse rather than take on faith.
    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: b.id,
      projectileId: projId,
      position: { x: 80, y: -200, z: 0 },
      airtime: 0.1,
      weaponType: 2,
    });
    step(room, 5);
    expect(w.count('playerHit')).toBe(0);
    expect(toA.filter((m) => m.type === 'shotRejected').length).toBe(1);
    expect(room.players.getPlayer(b.id)!.health).toBe(hpBefore);
  });
});
