import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { PlayerState } from '../../src/types.ts';

describe('scenario: deployable team targeting', () => {
  it('a turret shoots hostiles only — a teammate standing in range is ignored', () => {
    const room = mkRoom({ bots: 3 }, 'tdm');
    const w = watch(room);
    const [owner, mate, enemy] = [...room.players.getAllPlayers().values()].slice(0, 3) as [PlayerState, PlayerState, PlayerState];
    room.players.getPlayer(owner.id)!.team = 'alpha';
    room.players.getPlayer(mate.id)!.team = 'alpha';
    room.players.getPlayer(enemy.id)!.team = 'bravo';
    freeze(room, owner.id, { x: 0, y: 31, z: 0 });
    freeze(room, mate.id, { x: 14, y: 31, z: 0 });
    freeze(room, enemy.id, { x: 20, y: 31, z: 0 });
    room.deployables.handleDeploy(owner.id, 'turret', { x: 10, y: 31, z: 0 });
    w.msgs.length = 0;
    step(room, 80); // 4s — several fire intervals
    const shots = w.msgs.filter((m: ServerMessage) => m.type === 'turretShot');
    expect(shots.length).toBeGreaterThan(0);
    for (const s of shots) {
      expect((s as { targetId: string }).targetId).toBe(enemy.id);
    }
  });
});
