import { describe, expect, it } from 'bun:test';
import { TickLoop } from '../../src/TickLoop.ts';
import { STATUS } from '../../../shared/status.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, freeze } from './harness.ts';

// The tick a heal channel tops off maxHealth can land inside the 500ms
// echo cadence window — without the cap-out echo the client's hp trailed
// the server's converged value until the next discrete event.
describe('yourHealth cap-out echo', () => {
  it('crossing to maxHealth echoes even inside the cadence window', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-VEKTOR-01';
    freeze(room, id, { x: 0, y: 60, z: 0 });
    const p = room.players.getPlayer(id)!;
    // One mend tick shy of max — the next tick caps.
    p.health = p.maxHealth - 1;
    p.status |= STATUS.MEND;
    const sent: ServerMessage[] = [];
    room.connections.sendToPlayer = (pid, m) => { if (pid === id) sent.push(m); };
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    const t0 = Date.now();
    // First tick: heal applies (no cap yet — heals are < 1hp per tick),
    // cadence echo fires.
    loop.tickRoomNow(room, t0);
    const firstEchoes = sent.filter((m) => m.type === 'yourHealth').length;
    expect(firstEchoes).toBe(1);
    // Drive ticks until hp caps — the cap tick must echo even though
    // it's ~50ms after the last echo (cadence alone would suppress it).
    let capTick = -1;
    for (let i = 1; i < 60 && capTick < 0; i++) {
      loop.tickRoomNow(room, t0 + i * 50);
      if (p.health >= p.maxHealth) capTick = i;
    }
    expect(capTick).toBeGreaterThan(0);
    const echoes = sent.filter((m) => m.type === 'yourHealth');
    expect(echoes.length).toBeGreaterThan(1);
    expect(echoes[echoes.length - 1]).toMatchObject({ type: 'yourHealth', health: p.maxHealth });
    // No spam: once capped, healPerTick returns 0 — further ticks echo nothing.
    const countAtCap = echoes.length;
    loop.tickRoomNow(room, t0 + (capTick + 2) * 50);
    expect(sent.filter((m) => m.type === 'yourHealth').length).toBe(countAtCap);
  });
});
