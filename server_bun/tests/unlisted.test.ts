import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { Room } from '../src/Room.ts';
import type { RoomMods } from '../../shared/protocol.ts';

function fakeWs() {
  const sent: string[] = [];
  return {
    sent,
    data: {} as { playerId?: string },
    remoteAddress: '127.0.0.1',
    readyState: 1,
    send(m: string) { sent.push(m); return m.length; },
    close() { /* test double */ },
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

interface Peek {
  factory: { roomFor(name: string, mode?: string, map?: string, bots?: number, mods?: RoomMods): Room | null;
           quickRoom(mode: string, map?: string, bots?: number, mods?: RoomMods): Room | null };
  rooms: Map<string, Room>;
  tickLoop: { stop(): void };
  listRooms(): unknown[];
}

// Private-room contract: an unlisted room is joinable by name but never
// surfaces to the public browse — not in /rooms, not as a quick-join
// target. A dropped filter silently leaks the room.
describe('unlisted rooms', () => {
  it('does not appear in /rooms or absorb quick-joins', () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const priv = peek.factory.roomFor('secret', 'ctf', '', 0, { unlisted: true })!;
      expect(priv.mods.unlisted).toBe(true);

      // /rooms hides it.
      expect((peek.listRooms() as { name: string }[]).map(r => r.name)).not.toContain('secret');

      // A quick-joiner must not land inside it — they mint a fresh room.
      const joined = peek.factory.quickRoom('ctf');
      expect(joined).not.toBe(priv);
      expect(joined!.name).not.toBe('secret');

      // But naming it still joins — that is the whole feature.
      expect(peek.factory.roomFor('secret')).toBe(priv);
    } finally {
      peek.tickLoop.stop();
    }
  });

  it('a switchRoom hop mints unlisted when asked, and can join one by name', async () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const ws = fakeWs();
      gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'lobby' }));

      // Hop minting a private room — the flag must survive the hop or the
      // hosted match leaks into /rooms the moment it forms.
      gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'vip', unlisted: true }));
      const vip = peek.rooms.get('vip')!;
      expect(vip.mods.unlisted).toBe(true);
      expect((peek.listRooms() as { name: string }[]).map(r => r.name)).not.toContain('vip');

      // A friend hopping BY NAME lands inside it — unlisted hides the room
      // from browse, never from a targeted join. Minted-terrain hops seat
      // when the field lands (buried-spawn gate), so poll for the seat
      // rather than asserting synchronously.
      const ws2 = fakeWs();
      gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'lobby' }));
      gs.onMessage(ws2, JSON.stringify({ type: 'switchRoom', room: 'vip' }));
      for (let i = 0; i < 100 && !vip.players.getPlayer('p2'); i++) {
        await new Promise(r => setTimeout(r, 20));
      }
      expect(vip.players.getPlayer('p2')).toBeTruthy();
    } finally {
      peek.tickLoop.stop();
    }
  });
});
