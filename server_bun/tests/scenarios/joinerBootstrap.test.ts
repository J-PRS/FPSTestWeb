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
    // Creature kills during the warm-up can drop extra gems — the joiner
    // just needs the staged one present, not an exact count.
    expect((gs!.pickups as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(gs!.team).toBeTruthy();
    expect(gs!.localPlayerState).toBeTruthy();
    // Ball + crawler rosters ride behind gameState as their own messages.
    expect(sent.some((m) => m.type === 'ballRoster')).toBe(true);
    const cr = sent.find((m) => m.type === 'crawlRoster') as { crawlers: unknown[] } | undefined;
    expect(cr!.crawlers.length).toBe(3);
  });

  it('gameState is a faithful mirror of live truth — not a stale snapshot', () => {
    // Presence alone can pass while the payload drifts (a joiner would
    // reconstruct a world that disagrees with the authority's). Assert
    // every echoed value equals what the room currently believes.
    const room = mkRoom({
      mode: 'ctf', bots: 4,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf', 7, true); // moveAuthority: player rows are sim-fed
    step(room, 60);
    room.players.addPlayer('JOINER');
    const joiner = room.players.getPlayer('JOINER')!;
    joiner.team = 'alpha';
    joiner.hasReceivedPosition = true;
    const sent: ServerMessage[] = [];
    const orig = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === 'JOINER') sent.push(m); else orig(pid, m); };
    room.messages.handleHandshake('JOINER');
    const gs = sent.find((m) => m.type === 'gameState') as Record<string, unknown> | undefined;
    expect(gs).toBeTruthy();

    type GsPlayer = { id: string; position: { x: number; y: number; z: number }; team: string };
    const roster = gs!.players as GsPlayer[];
    const live = room.players.getAllPlayers();
    // Roster completeness: every in-world body except the joiner itself
    // (the roster is "others" — the joiner arrives via localPlayerState).
    expect(roster.length).toBe(live.size - 1);
    const byId = new Map(roster.map((r) => [r.id, r]));
    for (const [id, p] of live) {
      if (id === 'JOINER') continue;
      const row = byId.get(id);
      expect(row, `roster missing ${id}`).toBeTruthy();
      // Echoed position is the live sim position — the authority-mode
      // p.position IS the sim output (TickLoop copies s.pos each tick).
      expect(Math.hypot(
        row!.position.x - p.position.x,
        row!.position.y - p.position.y,
        row!.position.z - p.position.z,
      ), `stale pos for ${id}`).toBeLessThan(0.01);
      expect(row!.team).toBe(p.team!);
    }
    // localPlayerState echoes the joiner's own live truth (position,
    // health) — the client seeds its prediction sim from this.
    const lps = gs!.localPlayerState as { position: { x: number; y: number; z: number }; health: number };
    expect(Math.hypot(
      lps.position.x - joiner.position.x,
      lps.position.y - joiner.position.y,
      lps.position.z - joiner.position.z,
    )).toBeLessThan(0.01);
    expect(lps.health).toBe(joiner.health);
    // Flags: snapshot carrier/position semantics match live flag state.
    const flags = gs!.flags as { team: string; carrier?: string | null }[];
    expect(flags.length).toBe(2);
    for (const f of room.flags!.flags.values()) {
      const snap = flags.find((s) => s.team === f.team);
      expect(snap, `flag snapshot missing ${f.team}`).toBeTruthy();
      expect(snap!.carrier ?? null).toBe(f.carrier);
    }
  });
});
