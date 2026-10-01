import { afterEach, describe, expect, it } from 'bun:test';

import { BotGoals, type GoalState } from '../../shared/botGoals.ts';
import { botRng } from '../../shared/botRand.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';

const flat = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now: 0,
  groundY: () => 0,
  ...over,
});

const kit = (over: { wanderlust?: number; heading?: { x: number; z: number }; nearDeath?: (p: { x: number; z: number }) => boolean } = {}) => {
  const s: GoalState = {
    goal: { x: 0, y: 0, z: 0 },
    revengeT: 0, revengeFrom: { x: 0, y: 0, z: 0 },
    wanderT: 0, wanderWp: { x: 0, y: 0, z: 0 },
  };
  const g = new BotGoals(
    () => s,
    () => over.wanderlust ?? 1,
    () => over.heading ?? { x: 1, z: 0 },
    over.nearDeath ?? (() => false),
  );
  return { s, g };
};

afterEach(() => botRng(Math.random));

describe('BotGoals.pick — priority ladder', () => {
  const pos = { x: 0, y: 0, z: 0 };

  it('revenge outranks everything — goal becomes the shooter', () => {
    const { s, g } = kit();
    s.revengeT = 1;
    s.revengeFrom = { x: 7, y: 0, z: 7 };
    g.pick(flat({ objective: { x: 1, y: 0, z: 1 } }), pos);
    expect(s.goal).toEqual({ x: 7, y: 0, z: 7 });
  });

  it('objective outranks pickup and wander', () => {
    const { s, g } = kit();
    g.pick(flat({ objective: { x: 40, y: 0, z: 40 }, pickup: { x: 5, y: 0, z: 5 } }), pos);
    expect(s.goal).toEqual({ x: 40, y: 0, z: 40 });
  });

  it('pickup beats a fresh wander roll', () => {
    const { s, g } = kit();
    g.pick(flat({ pickup: { x: 5, y: 0, z: 5 } }), pos);
    expect(s.goal).toEqual({ x: 5, y: 0, z: 5 });
  });

  it('critically hurt folds toward the nearest ally', () => {
    const { s, g } = kit();
    g.pick(flat({
      objective: { x: 40, y: 0, z: 40 },
      healthFrac: 0.1,
      allies: [{ x: 12, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }],
    }), pos);
    expect(s.goal).toEqual({ x: 3, y: 0, z: 0 });
  });

  it('heard fight pulls only on a curiosity roll', () => {
    const { s, g } = kit({ wanderlust: 1 });
    const c = flat({ sounds: [{ x: 8, y: 0, z: 8 }] });
    botRng(() => 0.9); // fails the roll → no goal change
    g.pick(c, pos);
    expect(s.goal).toEqual({ x: 0, y: 0, z: 0 });
    botRng(() => 0.1); // curious → investigate
    g.pick(c, pos);
    expect(s.goal).toEqual({ x: 8, y: 0, z: 8 });
  });
});

describe('BotGoals wander', () => {
  const pos = { x: 0, y: 0, z: 0 };

  it('picks a committed forward-cone waypoint and arms the timer', () => {
    const { s, g } = kit({ heading: { x: 1, z: 0 } });
    botRng(() => 0.5);
    g.pick(flat(), pos);
    expect(s.wanderT).toBeGreaterThan(0);
    // wanderlust 1, r = 25+0.5*55 ≈ 52m along ~heading
    expect(Math.hypot(s.goal.x, s.goal.z)).toBeGreaterThan(20);
    expect(s.goal.x).toBeGreaterThan(0); // forward cone, not a reversal
  });

  it('downhill candidates win the roll', () => {
    const { s, g } = kit({ heading: { x: 1, z: 0 } });
    // Ground drops toward +x — every roll in the cone is downhill-ish,
    // and the pick should land on the lowest reachable one.
    const c = flat({ groundY: (x) => 100 - x });
    botRng(() => 0.5);
    g.pick(c, pos);
    expect(s.goal.x).toBeGreaterThan(20);
  });

  it('death spots are skipped outright', () => {
    const { s, g } = kit({ nearDeath: () => true }); // everything's cursed
    botRng(() => 0.5);
    g.pick(flat(), pos);
    expect(s.goal).toEqual({ x: 0, y: 0, z: 0 }); // no valid roll → goal untouched
  });

  it('committed waypoint holds until reached or timed out', () => {
    const { s, g } = kit({ wanderlust: 0.01 }); // wanderT rolls huge
    botRng(() => 0.5);
    g.pick(flat(), pos);
    const first = { ...s.goal };
    // Second pick: still committed — no new roll while wanderT>0 and
    // waypoint is >3m away.
    g.pick(flat(), pos);
    expect(s.goal).toEqual(first);
  });
});
