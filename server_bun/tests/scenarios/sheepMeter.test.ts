import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, freeze, step } from './harness.ts';

// Sheep meter: pedestrian play fills it, the yeet launches the offender
// and pins its jets, respawn and silenced bots get a clean slate.
describe('sheep meter', () => {
  it('a full meter yeets the bot — impulse launch + pinned jets', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-t1';
    pin(room, id, { x: 0, y: 60, z: 0 });
    room.bots.debugSetSheep(id, 99.9);
    step(room, 3);
    expect(room.bots.debugYeeted(id)).toBe(true);
    // The yeet resets to 40 — the launch itself buys back mobility credit.
    expect(room.bots.sheepOf(id)).toBeLessThanOrEqual(50);
  });

  it('a thinking bot that stays Tribes-ing never fills the meter', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-t1';
    step(room, 40); // ~2 sim-seconds of wandering
    expect(room.bots.sheepOf(id)).toBeLessThan(100);
  });

  it('silenced bots never accrue — a frozen body is a prop, not a sheep', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-t1';
    freeze(room, id, { x: 0, y: 60, z: 0 });
    step(room, 40);
    expect(room.bots.sheepOf(id)).toBe(0);
  });

  it('the coverage window debits a bot that claims a destination but goes nowhere', () => {
    const room = mkRoom({ bots: 1 });
    const bots = room.bots as unknown as {
      coverageDebit(id: string, p: { position: { x: number; y: number; z: number } }, hasDest: boolean, simMs: number): number;
    };
    const p = { position: { x: 0, y: 60, z: 0 } };
    let debit = 0;
    for (let t = 0; t <= 5000; t += 100) debit = bots.coverageDebit('BOT-t1', p, true, t);
    expect(debit).toBe(20); // 5s window elapsed, zero real displacement
  });

  it('covering ground clears the window — speed-check squeakers included', () => {
    const room = mkRoom({ bots: 1 });
    const bots = room.bots as unknown as {
      coverageDebit(id: string, p: { position: { x: number; y: number; z: number } }, hasDest: boolean, simMs: number): number;
    };
    const p = { position: { x: 0, y: 60, z: 0 } };
    let debit = -1;
    for (let t = 0; t <= 5000; t += 100) {
      p.position.x += 10; // 100 m/s of honest travel — 500m over the window
      debit = bots.coverageDebit('BOT-t1', p, true, t);
    }
    expect(debit).toBe(0);
  });

  it('death and respawn reset the meter', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-t1';
    pin(room, id, { x: 0, y: 60, z: 0 });
    room.bots.debugSetSheep(id, 55);
    const p = room.players.getPlayer(id)!;
    room.players.applyDamage(id, 9999);
    p.isDead = true;
    step(room, 1);
    p.isDead = false; // respawn path: deadSet removal clears the slate
    p.position = { x: 0, y: 60, z: 0 };
    step(room, 1);
    expect(room.bots.sheepOf(id)).toBeLessThan(55);
  });
});
