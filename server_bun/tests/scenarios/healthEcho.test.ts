import { describe, expect, it } from 'bun:test';
import { TickLoop } from '../../src/TickLoop.ts';
import { STATUS } from '../../../shared/status.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, pin } from './harness.ts';

// yourHealth echo: self is excluded from tickUpdate, so server-owned
// heals (mend/regen/perk) would silently drift client hp — the desync.
// The echo re-tells the owner, throttled to ~2Hz.
describe('yourHealth echo', () => {
  function drain(room: ReturnType<typeof mkRoom>, sent: ServerMessage[], id: string) {
    room.connections.sendToPlayer = (pid, m) => { if (pid === id) sent.push(m); };
  }

  it('a mending player gets throttled yourHealth echoes', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-VEKTOR-01';
    pin(room, id, { x: 0, y: 60, z: 0 });
    const p = room.players.getPlayer(id)!;
    p.health = 50;
    p.status |= STATUS.MEND;
    const sent: ServerMessage[] = [];
    drain(room, sent, id);
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    loop.tickRoomNow(room);
    expect(sent.filter((m) => m.type === 'yourHealth').length).toBe(1);
    expect(p.health).toBeGreaterThan(50);
    // Throttle: a tick 100ms later must NOT echo again; 600ms must.
    loop.tickRoomNow(room, Date.now() + 100);
    expect(sent.filter((m) => m.type === 'yourHealth').length).toBe(1);
    loop.tickRoomNow(room, Date.now() + 600);
    expect(sent.filter((m) => m.type === 'yourHealth').length).toBe(2);
  });

  it('a full-health player never echoes — nothing to converge', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-VEKTOR-01';
    pin(room, id, { x: 0, y: 60, z: 0 });
    const sent: ServerMessage[] = [];
    drain(room, sent, id);
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    loop.tickRoomNow(room);
    expect(sent.filter((m) => m.type === 'yourHealth').length).toBe(0);
  });
});
