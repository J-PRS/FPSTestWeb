import { describe, it, expect } from 'bun:test';
import { STATUS } from '../../../shared/status.ts';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: cloak confuses the hunt', () => {
  it('a cloaked player leaves creatures hunting a ghost, not U-turning', () => {
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
    // Move AWAY under cloak — the ghost must stay near the old sighting.
    for (let i = 0; i < 300; i++) {
      pin(room, 'P1', { x: 80, y: 31, z: 60 });
      step(room, 1);
    }
    // Confused retargets keep hunting the LAST sighting: tp stays within
    // drift radius of (40,31,0), not the player's new position and not
    // dropped. An instant deaggro would emit tp-less/null retargets.
    const hunts = w.msgs.slice(seen).filter((m) => m.type === 'crawlEvt'
      && (m as { kind?: string }).kind === 'retarget'
      && (m as { targetId?: string }).targetId === 'P1'
      && (m as { tp?: { x: number; z: number } | null }).tp);
    expect(hunts.length).toBeGreaterThan(0);
    for (const h of hunts) {
      const tp = (h as { tp: { x: number; y: number; z: number } }).tp;
      const dGhost = Math.hypot(tp.x - 40, tp.z - 0);
      const dLive = Math.hypot(tp.x - 80, tp.z - 60);
      expect(dGhost).toBeLessThan(15);   // wobble around last sighting
      expect(dLive).toBeGreaterThan(30); // NOT tracking the cloaked player
    }
    // Decloak → the next retarget re-locks the LIVE position. Retargets
    // run ~8s sim-time, so give it a couple of intervals.
    p.status = 0;
    step(room, 500);
    const relock = w.msgs.slice(seen).some((m) => m.type === 'crawlEvt'
      && (m as { kind?: string }).kind === 'retarget'
      && (m as { targetId?: string }).targetId === 'P1'
      && (() => { const tp = (m as { tp?: { x: number; z: number } | null }).tp;
        return !!tp && Math.hypot(tp.x - 80, tp.z - 60) < 5; })());
    expect(relock).toBe(true);
  });
});
