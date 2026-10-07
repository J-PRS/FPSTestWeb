import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { Room } from '../src/Room.ts';

interface Peek {
  factory: { roomFor(name: string, mode?: string, map?: string, bots?: number, unlisted?: boolean): Room | null;
           quickRoom(mode: string, map?: string, bots?: number): Room | null };
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
      const priv = peek.factory.roomFor('secret', 'ctf', '', 0, true)!;
      expect(priv.unlisted).toBe(true);

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
});
