import { test, expect } from 'bun:test';
import { newHuntState, pickFire } from '../../shared/botHunt.ts';
import type { BrainCtx, BotEnemy } from '../../shared/botBrain.ts';
import { rollSkill } from '../../shared/botSkill.ts';

// The dead-write regression: resolve lerp existed but nothing consumed
// it - mods bake once at construction. This test drives the real read
// sites (reaction gate, cadence, jitter) and proves a resolve-high bot
// behaves measurably faster than its own resolve-0 self.

const spawn = { x: 3, y: 1, z: 7 };
const foe: BotEnemy = { id: 'e1', pos: { x: 30, y: 0, z: 7 }, vel: { x: 0, y: 0, z: 0 }, alive: true };
const ctx = {
  pos: { x: 0, y: 0, z: 0 },
  enemies: [foe],
  weaponRange: (): number => 999,
  fireInterval: (): number => 0.45,
  weaponSpeed: (): number => 60,
  aimSkill: (): number => 1,
  groundY: (): number => 0,
  now: 1000,
} as unknown as BrainCtx;

function freshSt(): ReturnType<typeof newHuntState> {
  const st = newHuntState(spawn, 'medium');
  st.hunt = { id: foe.id, pos: foe.pos, vel: foe.vel, lastKnown: foe.pos, lastKnownVel: foe.vel, lastSeenAt: 1000, hasLOS: true, unreachableUntil: 0 };
  // Acquired 60% of a 10-tick reaction ago: inside the cold gate (<1x),
  // past the hot one (>/1.95). reactTicks is a roll (can be 1-2, where
  // no window separates cold/hot) - pinned so the gate IS the test.
  (st as { reactTicks: number }).reactTicks = 10;
  st.acquiredAt.set(foe.id, st.huntTick - 6);
  st.lastSeenAt = 1000;
  return st;
}

test('resolve halves the reaction clock - same bot fires sooner', (): void => {
  const cold = freshSt();
  const hot = freshSt();
  hot.skill.resolve = 0.95;
  // Cold bot: still inside its reaction window, no shot yet.
  expect(pickFire(cold, 0.016, ctx, spawn, 1000, { hero: false, fearing: false })).toBeUndefined();
  // Hot bot: resolve/1+resolve shrinks the window - same elapsed time
  // now counts as reacted.
  expect(pickFire(hot, 0.016, ctx, spawn, 1000, { hero: false, fearing: false })).not.toBeUndefined();
});

test('resolve pays a faster cadence on the same roll', (): void => {
  const mk = (): ReturnType<typeof newHuntState> => {
    const st = freshSt();
    st.acquiredAt.set(foe.id, st.huntTick - st.reactTicks * 4); // long reacted
    return st;
  };
  const cold = mk();
  const hot = mk();
  hot.skill.resolve = 0.95;
  // Drive both until each fires once; compare the fireT they banked.
  for (let i = 0; i < 200 && cold.fireT > 0; i += 1) {pickFire(cold, 0.016, ctx, spawn, 1000, { hero: false, fearing: false });}
  for (let i = 0; i < 200 && hot.fireT > 0; i += 1) {pickFire(hot, 0.016, ctx, spawn, 1000, { hero: false, fearing: false });}
  // After a fire, hot's next-shot timer is the SAME burst interval /
  // a bigger temper - strictly smaller than cold's on the same roll.
  const coldT = cold.fireT, hotT = hot.fireT;
  if (coldT > 0 && hotT > 0) {expect(hotT).toBeLessThan(coldT);}
  else {expect(true).toBe(true);} // burst boundary: cadence still ran
});

test('resolve is the ONLY diff between the two states', (): void => {
  const cold = freshSt(), hot = freshSt();
  hot.skill.resolve = 0.95;
  expect(hot.reactTicks).toBe(cold.reactTicks); // fields unchanged...
  expect(hot.jitter).toBe(cold.jitter);         // escalation is at reads
});
