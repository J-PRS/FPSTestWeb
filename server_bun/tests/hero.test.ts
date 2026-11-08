import { test, expect } from 'bun:test';
import { rollSkill, heroTick, HERO_ON, BOT_TIERS } from '../../shared/botSkill.ts';

// heroTick shape: resolve follows pressure (deficit*perf + menace),
// escalation lerps every dial toward impossible - and never below the
// roll a bot was already born with (the nerf regression).
const tick = (s: ReturnType<typeof rollSkill>, p: { deficit: number; ownPerf: number; menace: number }, secs: number): void => {
  for (let t = 0; t < secs; t += 0.1) {heroTick(s, p, 0.1);}
};

test('resolve rises under deficit and cools when it passes', (): void => {
  const s = rollSkill({ x: 3, y: 1, z: 7 }, 'medium');
  tick(s, { deficit: 0.8, ownPerf: 0.9, menace: 0.6 }, 6);
  expect(s.resolve).toBeGreaterThan(0.7);
  tick(s, { deficit: 0, ownPerf: 0.5, menace: 0 }, 60);
  expect(s.resolve).toBeLessThan(0.1);
});

test('a nobody under no pressure stays flat (drift only)', (): void => {
  const s = rollSkill({ x: 9, y: 1, z: 2 }, 'easy');
  tick(s, { deficit: 0, ownPerf: 0, menace: 0 }, 10);
  expect(s.resolve).toBeLessThan(0.2);
});

test('escalation never nerfs: hard-spec axes only rise', (): void => {
  const s = rollSkill({ x: 5, y: 2, z: 9 }, 'impossible');
  const baseAim = s.baseAxes.snap.moving;
  const {baseMove} = s;
  tick(s, { deficit: 1, ownPerf: 1, menace: 1 }, 10);
  expect(s.resolve).toBeGreaterThan(0.9);
  expect(s.axes.snap.moving).toBeGreaterThanOrEqual(baseAim);
  expect(s.movement).toBeGreaterThanOrEqual(baseMove);
  expect(s.mods.react).toBeLessThanOrEqual(s.baseMods.react);
});

test('mods approach the impossible tier at full resolve', (): void => {
  const s = rollSkill({ x: 1, y: 1, z: 1 }, 'easy');
  tick(s, { deficit: 1, ownPerf: 1, menace: 1 }, 30);
  expect(s.mods.aim).toBeCloseTo(BOT_TIERS.impossible.aim, 1);
  expect(s.mods.react).toBeCloseTo(BOT_TIERS.impossible.react, 1);
});

test('toggle flag exists and is on', (): void => {
  expect(HERO_ON).toBe(true);
});
