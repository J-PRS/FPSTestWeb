import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';

function fakeWs() {
  const sent: string[] = [];
  return {
    sent,
    data: {} as { playerId?: string },
    remoteAddress: '127.0.0.1',
    readyState: 1,
    send(m: string) { sent.push(m); return m.length; },
    close() {},
  } as any;
}

describe('nugget deploy through the wire', () => {
  it('deploy nugget drains on tick, mints a gem, acks the claim', () => {
    const gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'nug-room', mode: 'headhunt', bots: 0 }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { pickups: { snapshot(): { kind: string }[] }; players: { getPlayer(id: string): { position: { x: number; y: number; z: number } } | undefined }; drainCommands(): void }> });
    const room = rooms.get('nug-room')!;
    const me = room.players.getPlayer('p1')!;

    gs.onMessage(ws, JSON.stringify({ type: 'deploy', kind: 'nugget', position: { x: me.position.x + 2, y: me.position.y, z: me.position.z }, claimSeq: 1 }));
    // Thrown-pod claim at release — lob velocity lets the pickup sim own
    // the flight; a landing-time claim >40m out reads 'toofar' (the real
    // disappearing-nugget bug).
    gs.onMessage(ws, JSON.stringify({ type: 'deploy', kind: 'nugget', position: { x: me.position.x + 1, y: me.position.y + 0.4, z: me.position.z }, vel: { x: 20, y: 5, z: 0 }, claimSeq: 2 }));
    room.drainCommands(); // claims land at phase 0 of the next tick

    const acks = ws.sent.map((s: string) => { try { return JSON.parse(s) as { type?: string; ok?: boolean; seq?: number } | null; } catch { return null; } }).filter((m: { type?: string } | null) => m?.type === 'claimAck');
    const gems = room.pickups.snapshot().filter((p) => p.kind === 'gem');
    console.log('acks:', JSON.stringify(acks), 'gems:', gems.length);
    gs.stop();
    expect(gems.length).toBe(2);
    expect(gems.some((p) => (p as unknown as { vel?: { x: number } }).vel?.x === 20)).toBe(true); // the thrown one carries its lob
    expect(acks.every((m: { ok?: boolean } | null) => m?.ok)).toBe(true);
  });
});
