import { describe, it, expect } from 'bun:test';
import { STATUS } from '../../../shared/status.ts';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: cloak breaks the hunt', () => {
  it('a cloaked player drops off the creature target list', () => {
    const room = mkRoom({ creatures: { crawler: 3 } });
    const w = watch(room);
    // A non-bot player — server brains stomp status each think, so a bot
    // can't hold a manual cloak; a human's status bit is only wire-set.
    room.players.addPlayer('P1');
    const p = room.players.getPlayer('P1')!;
    p.health = 1000;
    pin(room, 'P1', { x: 40, y: 31, z: 0 });
    // Uncloaked first: creatures spawn near the player and commit —
    // prove aggro actually existed before the stealth claim means anything.
    step(room, 200);
    const committed = w.msgs.some((m) => m.type === 'crawlEvt'
      && (m as { kind?: string }).kind === 'retarget'
      && (m as { targetId?: string }).targetId === 'P1');
    expect(committed).toBe(true);
    const seen = w.msgs.length;
    p.status = STATUS.CLOAK;
    for (let i = 0; i < 400; i++) {
      pin(room, 'P1', { x: 40, y: 31, z: 0 });
      step(room, 1);
    }
    // Every bite edge a cloaked player absorbs past the drop is a stealth lie.
    const lies = w.msgs.slice(seen).filter((m) => m.type === 'crawlEvt'
      && (m as { kind?: string }).kind === 'bite'
      && (m as { targetId?: string }).targetId === 'P1');
    expect(lies.length).toBe(0);
  });
});
