import { describe, it, expect } from 'bun:test';
import { STATUS } from '../../../shared/status.ts';
import type { Vec3 } from '../../src/types.ts';
import { simNowAdvance } from '../../src/simClock.ts';
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
    // Brain memory (pursuit/stale windows) is measured in simNow — scenario
    // ticks don't move that clock, so without this the ghost of the last
    // contact is immortal and the bot "aims" at it forever.
    simNowAdvance(5000);
    const before = w.msgs.length;
    for (let i = 0; i < 200; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      pin(room, 'P1', { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    // The contract is aimed shots, not projectile count: the bot's own
    // disc-jump propels spawn bolts at its feet regardless of cloaks,
    // and their splash clipping a pinned neighbor is incidental, not
    // aim-through-cloak. Only shots directed at the target count.
    const aimedAtP1 = w.msgs.slice(before).filter((m) => {
      if (m.type !== 'projectileCreated') return false;
      const v = (m as { velocity?: Vec3; position?: Vec3 });
      if (!v.velocity || !v.position) return false;
      const tx = 50 - v.position.x, ty = 31 - v.position.y, tz = 0 - v.position.z;
      const tl = Math.hypot(tx, ty, tz) || 1, vl = Math.hypot(v.velocity.x, v.velocity.y, v.velocity.z) || 1;
      return (v.velocity.x * tx + v.velocity.y * ty + v.velocity.z * tz) / (vl * tl) > 0.97;
    }).length;
    expect(aimedAtP1).toBe(0);
  });
});
