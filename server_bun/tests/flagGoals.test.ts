import { describe, test, expect } from 'bun:test';
import { roleObjective, ROLE_PRIORITY, type FlagSituation } from '../../shared/flagGoals.ts';

const V = (x: number, y: number, z: number) => ({ x, y, z });
const HOME = V(0, 0, 0);
const ENEMY = V(100, 0, 100);
const THIEF = V(30, 0, 30);
const DROPPED = V(10, 0, 10);
const DROPPED_FAR = V(200, 0, 200);
const ESCORT = V(50, 0, 50);

function sit(o: Partial<FlagSituation> = {}): FlagSituation {
  return { home: HOME, thief: null, dropped: null, enemyStand: ENEMY, escort: null, ...o };
}

describe('roleObjective', () => {
  test('hof never leaves the stand for a thief', () => {
    // That's what light defense is for — a HoF chasing = open base.
    expect(roleObjective('hof', sit({ thief: THIEF }))).toBe(HOME);
  });
  test('hof picks up a dropped flag only in easy reach', () => {
    expect(roleObjective('hof', sit({ dropped: DROPPED }))).toBe(DROPPED);
    expect(roleObjective('hof', sit({ dropped: DROPPED_FAR }))).toBe(HOME);
  });
  test('defense roles chase thief > dropped > hold home', () => {
    for (const role of ['ldefense', 'technician', 'defense']) {
      expect(roleObjective(role, sit({ thief: THIEF, dropped: DROPPED }))).toBe(THIEF);
      expect(roleObjective(role, sit({ dropped: DROPPED }))).toBe(DROPPED);
      expect(roleObjective(role, sit())).toBe(HOME);
    }
  });
  test('capper escorts a carrier first, else presses the stand', () => {
    expect(roleObjective('capper', sit({ escort: ESCORT, enemyStand: ENEMY }))).toBe(ESCORT);
    expect(roleObjective('capper', sit())).toBe(ENEMY);
    // Stand not grabbable (already carried by teammate w/o escort pos) → home.
    expect(roleObjective('capper', sit({ enemyStand: null }))).toBe(HOME);
  });
  test('infiltrator presses the stand even with a thief loose', () => {
    expect(roleObjective('infiltrator', sit({ thief: THIEF }))).toBe(ENEMY);
    expect(roleObjective('infiltrator', sit({ escort: ESCORT }))).toBe(ESCORT);
  });
  test('offense punishes a thief before pressing', () => {
    expect(roleObjective('offense', sit({ thief: THIEF }))).toBe(THIEF);
    expect(roleObjective('offense', sit({ dropped: DROPPED }))).toBe(DROPPED);
    expect(roleObjective('offense', sit())).toBe(ENEMY);
  });
  test('unknown roles fall back to offense policy', () => {
    expect(roleObjective('whatever', sit({ thief: THIEF }))).toBe(THIEF);
    expect(roleObjective('whatever', sit())).toBe(ENEMY);
  });
});

describe('ROLE_PRIORITY', () => {
  test('core roles unlock before luxury ones as squads grow', () => {
    const mins = ROLE_PRIORITY.map(r => r.minSquad);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    expect(ROLE_PRIORITY[0]!.role).toBe('capper'); // the flag route is the job
  });
});
