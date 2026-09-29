import { describe, it, expect } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, step } from './harness.ts';

describe('scenario: mid-match joiner gets the world', () => {
  it('handshake echoes mode/scores/flags/live rosters so a joiner is never blind', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
      creatures: { crawler: 3 },
    }, 'ctf');
    // A visible body first: creature spawns anchor on UNCLOAKED players,
    // and server bots legitimately cloak at spawn — with no visible
    // target the world stays empty.
    room.players.addPlayer('P1');
    const p = room.players.getPlayer('P1')!;
    p.team = 'alpha';
    // A live world before the joiner shows up: crawlers out, a gem down,
    // a score already banked.
    step(room, 40);
    room.score('alpha', 2);
    room.pickups!.spawn({ x: 5, y: 31, z: 5 }, 'gem');
    const sent: ServerMessage[] = [];
    const orig = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === 'P1') sent.push(m); else orig(pid, m); };
    room.messages.handleHandshake('P1');

    const gs = sent.find((m) => m.type === 'gameState') as Record<string, unknown> | undefined;
    expect(gs).toBeTruthy();
    expect(gs!.mode).toBe('ctf');
    expect((gs!.scores as { alpha: number }).alpha).toBe(2);
    // Bots on the roster (the joiner isn't one of them), flags, live gem.
    expect((gs!.players as unknown[]).length).toBe(2);
    expect((gs!.flags as unknown[]).length).toBe(2);
    expect((gs!.pickups as unknown[]).length).toBe(1);
    expect(gs!.team).toBeTruthy();
    expect(gs!.localPlayerState).toBeTruthy();
    // Ball + crawler rosters ride behind gameState as their own messages.
    expect(sent.some((m) => m.type === 'ballRoster')).toBe(true);
    const cr = sent.find((m) => m.type === 'crawlRoster') as { crawlers: unknown[] } | undefined;
    expect(cr!.crawlers.length).toBe(3);
  });
});
