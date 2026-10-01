import { afterEach, describe, expect, it } from 'bun:test';

import { BotBrain, type BotEnemy, type BrainCtx } from '../../shared/botBrain.ts';
import { pickDest, pickDeploy, statusIntent } from '../../shared/botDisposition.ts';
import { botRng } from '../../shared/botRand.ts';
import { STATUS } from '../../shared/status.ts';
import { ENERGY } from '../../shared/movement.ts';

const enemy = (x: number, z: number): BotEnemy => ({
  pos: { x, y: 0, z },
  vel: { x: 0, y: 0, z: 0 },
} as BotEnemy);

const ctx = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now: 0,
  groundY: () => 0,
  ...over,
});

const brain = () => new BotBrain({ x: 0, y: 0, z: 0 });

afterEach(() => botRng(Math.random));

describe('pickDest', () => {
  it('flinch overrides everything — flees from the hit', () => {
    const b = brain();
    b.h.hunt = enemy(0, 0);
    b.flinchT = 1;
    b.flinchFrom = { x: 10, y: 0, z: 0 };
    const d = pickDest(b, 0.1, ctx(), { x: 0, y: 0, z: 0 }, false, false);
    expect(d.x).toBeLessThan(0); // pushed away from the hit, not toward it
    expect(b.flinchT).toBeLessThan(1); // drained while fleeing
  });

  it('no hunt → the idle goal wins', () => {
    const b = brain();
    b.goalS.goal = { x: 10, y: 0, z: -5 };
    expect(pickDest(b, 0.1, ctx(), { x: 0, y: 0, z: 0 }, false, false)).toEqual({ x: 10, y: 0, z: -5 });
  });

  it('point-blank presses straight at the target', () => {
    const b = brain();
    b.h.hunt = enemy(3, 0); // inside CLOSE_PRESS_M
    const d = pickDest(b, 0.1, ctx(), { x: 0, y: 0, z: 0 }, false, false);
    expect(d).toEqual({ x: 3, y: 0, z: 0 });
  });

  it('outranged presses in too', () => {
    const b = brain();
    b.h.hunt = enemy(1000, 0);
    const d = pickDest(b, 0.1, ctx(), { x: 0, y: 0, z: 0 }, false, false);
    expect(d).toEqual({ x: 1000, y: 0, z: 0 });
  });

  it('mid-range holds an orbit inside the range band — never idles', () => {
    const b = brain();
    b.h.hunt = enemy(b.h.orbitFar * 0.6, 0);
    const d = pickDest(b, 0.1, ctx(), { x: 0, y: 0, z: 0 }, false, false);
    const r = Math.hypot(d.x - b.h.hunt.pos.x, d.z - b.h.hunt.pos.z);
    expect(r).toBeGreaterThan(0.1); // an orbit point, not the target itself
    expect(b.holding).toBe(true);
  });

  it('a committed fightPos wins over recomputing the orbit', () => {
    const b = brain();
    b.h.hunt = enemy(b.h.orbitFar * 0.6, 0);
    b.h.fightPos = { x: 50, y: 0, z: 50 };
    expect(pickDest(b, 0.1, ctx(), { x: 0, y: 0, z: 0 }, false, false)).toEqual({ x: 50, y: 0, z: 50 });
    expect(b.holding).toBe(false);
  });
});

describe('pickDeploy', () => {
  it('non-builders never plant', () => {
    const b = brain();
    b.builder = false;
    expect(pickDeploy(b, 0.1, ctx({ objective: { x: 0, y: 0, z: 0 } }), { x: 0, y: 0, z: 0 }, false)).toBeUndefined();
  });

  it('enemy nearby → hands are not free', () => {
    const b = brain();
    b.builder = true;
    b.deployT = 0;
    b.h.hunt = enemy(10, 0); // within the 25m "hands free" gate
    expect(pickDeploy(b, 0.1, ctx({ objective: { x: 0, y: 0, z: 0 } }), { x: 0, y: 0, z: 0 }, false)).toBeUndefined();
  });

  it('hurting builders pick a station first', () => {
    const b = brain();
    b.builder = true;
    b.deployT = 0;
    botRng(() => 0.5);
    const d = pickDeploy(b, 0.1, ctx({ objective: { x: 0, y: 0, z: 0 }, healthFrac: 0.3 }), { x: 0, y: 0, z: 0 }, false);
    expect(d?.kind).toBe('station');
    expect(b.deployT).toBeGreaterThan(0); // cooldown engaged
  });
});

describe('statusIntent', () => {
  it('no energy model → no intent at all', () => {
    expect(statusIntent(brain(), ctx(), false)).toBeUndefined();
  });

  it('hurt + unpressured + can afford → MEND', () => {
    const s = statusIntent(brain(), ctx({ energy: ENERGY.mendCost + 50, healthFrac: 0.4 }), false);
    expect(s! & STATUS.MEND).toBe(STATUS.MEND);
  });

  it('fighting with a full tank → SHIELD', () => {
    const b = brain();
    b.h.hunt = enemy(10, 0);
    const s = statusIntent(b, ctx({ energy: ENERGY.shieldCost + 50 }), false);
    expect(s! & STATUS.SHIELD).toBe(STATUS.SHIELD);
  });

  it('covert infiltration → CLOAK, but drops once fighting', () => {
    const b = brain();
    const c = ctx({ energy: ENERGY.cloakCost + 50, infiltrating: true });
    expect(statusIntent(b, c, false)! & STATUS.CLOAK).toBe(STATUS.CLOAK);
    b.h.hunt = enemy(10, 0);
    expect(statusIntent(b, c, false)! & STATUS.CLOAK).toBe(0);
  });

  it('broke → nothing', () => {
    expect(statusIntent(brain(), ctx({ energy: 0, healthFrac: 0.3 }), false)).toBe(0);
  });
});
