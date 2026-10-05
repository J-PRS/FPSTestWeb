import { describe, it, expect } from 'bun:test';
import { STATUS } from '../../../shared/status.ts';
import { simNow, simNowAdvance } from '../../src/simClock.ts';
import { mkRoom, step, pin, watch, firstPlayer } from './harness.ts';

// Decloak-on-fire: a cloaked target that shoots owes 2s of visibility —
// bots regain him mid-stealth, then lose him again when the window lapses.
// lastFireSim is what the Room 'fire' handler stamps on every claim.
const aimedShotsAt = (msgs: object[], tx: number, ty: number, tz: number, from = 0) =>
  msgs.slice(from).filter((m) => {
    if ((m as { type?: string }).type !== 'projectileCreated') return false;
    const v = m as { velocity?: { x: number; y: number; z: number }; position?: { x: number; y: number; z: number } };
    if (!v.velocity || !v.position) return false;
    const dx = tx - v.position.x, dy = ty - v.position.y, dz = tz - v.position.z;
    const dl = Math.hypot(dx, dy, dz) || 1, vl = Math.hypot(v.velocity.x, v.velocity.y, v.velocity.z) || 1;
    return (v.velocity.x * dx + v.velocity.y * dy + v.velocity.z * dz) / (vl * dl) > 0.97;
  }).length;

describe('scenario: firing decloaks for 2s', () => {
  it('a cloaked shooter becomes aimable inside the reveal window, then hides again', () => {
    const room = mkRoom({ mode: 'tdm', bots: 1 });
    const w = watch(room);
    const bot = firstPlayer(room);
    room.players.addPlayer('P1');
    const p = room.players.getPlayer('P1')!;
    p.team = bot.team === 'alpha' ? 'bravo' : 'alpha';
    p.health = 1000;
    p.status = STATUS.CLOAK;
    p.lastFireSim = simNow(); // he just fired — reveal window live
    // Let pre-reveal traffic drain so the count below is only new fire.
    for (let i = 0; i < 40; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      pin(room, 'P1', { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    const during = w.msgs.length;
    for (let i = 0; i < 120; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      pin(room, 'P1', { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    expect(aimedShotsAt(w.msgs, 50, 31, 0, during)).toBeGreaterThan(0);
    // Window lapses — the senses stop seeing him again.
    simNowAdvance(6000);
    const after = w.msgs.length;
    for (let i = 0; i < 150; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      pin(room, 'P1', { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    expect(aimedShotsAt(w.msgs, 50, 31, 0, after)).toBe(0);
  });
});
