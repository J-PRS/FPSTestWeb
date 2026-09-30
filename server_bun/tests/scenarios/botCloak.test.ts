import { describe, it, expect } from 'bun:test';
import { STATUS } from '../../../shared/status.ts';
import { mkRoom, step, pin, watch, firstPlayer } from './harness.ts';

describe('scenario: bots cannot aim a cloaked target', () => {
  it('an enemy bot engages, then loses the shot when the target cloaks', () => {
    const room = mkRoom({ mode: 'tdm', bots: 1 });
    const w = watch(room);
    const bot = firstPlayer(room);
    // A non-bot victim — server brains stomp status each think.
    room.players.addPlayer('P1');
    const p = room.players.getPlayer('P1')!;
    p.team = bot.team === 'alpha' ? 'bravo' : 'alpha';
    p.health = 1000;
    for (let i = 0; i < 400; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      pin(room, 'P1', { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    const hits = () => w.msgs.filter((m) => m.type === 'playerHit' && (m as { targetId?: string }).targetId === 'P1').length;
    expect(hits()).toBeGreaterThan(0);
    p.status = STATUS.CLOAK;
    // Drain in-flight shells — a round launched pre-cloak landing on the
    // target is a legal hit, not aim through cloak.
    for (let i = 0; i < 40; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      pin(room, 'P1', { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    const before = w.msgs.length;
    for (let i = 0; i < 200; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      pin(room, 'P1', { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    expect(w.msgs.slice(before).filter((m) => m.type === 'playerHit' && (m as { targetId?: string }).targetId === 'P1').length).toBe(0);
  });
});
