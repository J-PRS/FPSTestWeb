import { describe, it, expect } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, step, watch } from './harness.ts';

describe('scenario: spectator join', () => {
  it('a watcher gets the world but no body — no playerJoined, no localPlayerState', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
      creatures: { crawler: 2 },
    }, 'ctf');
    const w = watch(room);
    step(room, 20);
    w.msgs.length = 0; // reset: the pre-game spawn noise isn't the test
    const sent: ServerMessage[] = [];
    const orig = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === 'SPEC') sent.push(m); else orig(pid, m); };
    room.messages.handleSpectatorHandshake('SPEC');
    const gs = sent.find((m) => m.type === 'gameState') as Record<string, unknown> | undefined;
    expect(gs).toBeTruthy();
    expect(gs!.mode).toBe('ctf');
    expect((gs!.players as unknown[]).length).toBe(2); // both bots visible
    expect(gs!.localPlayerState).toBeUndefined();     // no body to own
    expect(gs!.team).toBeUndefined();
    expect(sent.some((m) => m.type === 'ballRoster')).toBe(true);
    expect(sent.some((m) => m.type === 'crawlRoster')).toBe(true);
    // No player record exists for a spectator — nothing may announce one.
    expect(w.count('playerJoined')).toBe(0);
    expect(room.players.getPlayer('SPEC')).toBeUndefined();
  });
});
