import { afterEach, describe, expect, it } from 'bun:test';

import { BotGoals, type GoalState } from '../../shared/botGoals.ts';
import { botRng, botRngRelease } from '../../shared/botRand.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';

const flat = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now: 0,
  groundY: () => 0,
  ...over,
});

const kit = (over: { wanderlust?: number; heading?: { x: number; z: number }; nearDeath?: (p: { x: number; z: number }) => boolean; social?: number } = {}) => {
  const s: GoalState = {
    goal: { x: 0, y: 0, z: 0 },
    revengeT: 0, revengeFrom: { x: 0, y: 0, z: 0 },
    wanderT: 0, wanderWp: { x: 0, y: 0, z: 0 }, perchT: 0, lastWanderMode: 0, goalAge: 0, goalScore: 0,
  };
  const g = new BotGoals(
    () => s,
    () => over.wanderlust ?? 1,
    () => over.heading ?? { x: 1, z: 0 },
    over.nearDeath ?? (() => false),
    () => 1,
    () => over.social ?? 0.5,
  );
  return { s, g };
};

afterEach(() => botRngRelease());

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
    // Utility scoring, not a tier: at the SAME distance the objective's
    // heavier weight still wins the argmax. (A close gem legitimately
    // beats a far flag now — that trade is the point of the scoring.)
    g.pick(flat({ objective: { x: 40, y: 0, z: 40 }, pickup: { x: 40, y: 0, z: -40 } }), pos);
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

  it('a rattled social bot folds well before critical HP', () => {
    const { s, g } = kit({ social: 1 });
    // confidence 0 → nerve 1.1 → rallyAt ≈ 0.32: 28% HP is inside it.
    g.pick(flat({
      objective: { x: 40, y: 0, z: 40 },
      healthFrac: 0.28,
      confidence: 0,
      allies: [{ x: 3, y: 0, z: 0 }],
    }), pos);
    expect(s.goal).toEqual({ x: 3, y: 0, z: 0 });
  });

  it('a 0-social loner holds the near-death rally threshold', () => {
    const { s, g } = kit({ social: 0 });
    s.wanderT = 50; s.wanderWp = { x: 60, y: 0, z: 60 };
    // Same 28% HP — loner's rallyAt is ~0.09, so no fold: objective wins.
    g.pick(flat({
      objective: { x: 40, y: 0, z: 40 },
      healthFrac: 0.28,
      confidence: 0,
      allies: [{ x: 3, y: 0, z: 0 }],
    }), pos);
    expect(s.goal).toEqual({ x: 40, y: 0, z: 40 });
  });

  it('heard fight pulls only on a curiosity roll', () => {
    const { s, g } = kit({ wanderlust: 1 });
    // Pre-commit the wander slot so no rolls precede the curiosity one:
    // the wander candidate runs before heardGoal every pick.
    s.wanderT = 50; s.wanderWp = { x: 60, y: 0, z: 60 };
    const c = flat({ sounds: [{ x: 8, y: 0, z: 8 }] });
    botRng(() => 0.9); // fails the roll → the heard drive never offers
    g.pick(c, pos);
    expect(s.goal).toEqual({ x: 60, y: 0, z: 60 }); // falls to the wander leg
    botRng(() => 0.1); // curious → the heard fight outscores the wander
    g.pick(c, pos);
    expect(s.goal).toEqual({ x: 8, y: 0, z: 8 });
  });
});

describe('BotGoals.pick — ally drift', () => {
  const pos = { x: 0, y: 0, z: 0 };
  const farAlly = { x: 120, y: 0, z: 0 };

  it('a rattled social bot drifts toward a reachable ally', () => {
    const { s, g } = kit({ social: 1 });
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    g.pick(flat({ allies: [farAlly], confidence: 0, healthFrac: 1 }), pos);
    expect(s.goal).toEqual(farAlly);
  });

  it('a confident bot ignores the same ally — solo roam wins', () => {
    const { s, g } = kit({ social: 1 });
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    // confidence 1 → drift weight ~0.05 vs wander's 0.35.
    g.pick(flat({ allies: [farAlly], confidence: 1, healthFrac: 1 }), pos);
    expect(s.goal).toEqual({ x: -60, y: 0, z: -60 });
  });

  it('a loner trait never drifts regardless of nerve', () => {
    const { s, g } = kit({ social: 0 });
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    g.pick(flat({ allies: [farAlly], confidence: 0, healthFrac: 1 }), pos);
    expect(s.goal).toEqual({ x: -60, y: 0, z: -60 });
  });

  it('no pull while company is already close — no herding into a blob', () => {
    const { s, g } = kit({ social: 1 });
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    g.pick(flat({ allies: [{ x: 30, y: 0, z: 0 }, farAlly], confidence: 0, healthFrac: 1 }), pos);
    expect(s.goal).toEqual({ x: -60, y: 0, z: -60 });
  });

  it('no pull in objective modes — flag machinery owns cohesion there', () => {
    const { s, g } = kit({ social: 1 });
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    g.pick(flat({ objective: { x: 40, y: 0, z: 40 }, allies: [farAlly], confidence: 0, healthFrac: 1 }), pos);
    expect(s.goal).toEqual({ x: 40, y: 0, z: 40 });
  });
});

describe('BotGoals.pick — opportunity heat', () => {
  const pos = { x: 0, y: 0, z: 0 };

  it('a hot cell outbids wander when nothing else pulls', () => {
    const { s, g } = kit();
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    g.pick(flat({ imapHottest: () => ({ x: 90, z: 0, v: 0.6 }) }), pos);
    expect(s.goal.x).toBe(90);
    expect(s.goal.z).toBe(0);
  });

  it('a cold cell changes nothing', () => {
    const { s, g } = kit();
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    g.pick(flat({ imapHottest: () => ({ x: 90, z: 0, v: 0.2 }) }), pos);
    expect(s.goal).toEqual({ x: -60, y: 0, z: -60 });
  });

  it('a wave member holds the push — heat does not pull it off', () => {
    const { s, g } = kit();
    s.wanderT = 50; s.wanderWp = { x: -60, y: 0, z: -60 };
    g.pick(flat({ wave: true, imapHottest: () => ({ x: 90, z: 0, v: 0.9 }) }), pos);
    expect(s.goal).toEqual({ x: -60, y: 0, z: -60 });
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

  it('far from the crowd, wander rolls aim at its centroid', () => {
    const { s, g } = kit({ heading: { x: 1, z: 0 } });
    botRng(() => 0.5);
    // Bot at (500,0), crowd centroided at origin — heading says +x but
    // the pull says -x; the roll should land toward the crowd.
    g.pick(flat({ others: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: -10, y: 0, z: 0 }] }), { x: 500, y: 0, z: 0 });
    expect(s.goal.x).toBeLessThan(500);
    expect(s.goal.x).toBeGreaterThan(300); // a wander roll, not a teleport
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

describe('BotGoals switching cost — committed lines, free minds', () => {
  const pos = { x: 0, y: 0, z: 0 };
  const FAR = { x: 60, y: 0, z: 60 };     // ~85m of committed transit - wins the first argmax outright
  const NEAR = { x: 10, y: 0, z: 10 };    // a marginal detour - better raw score, worse reason

  it('a marginal near offer does NOT yank a committed far line', () => {
    const { s, g } = kit();
    botRng(() => 0.5);
    g.pick(flat({ pickup: FAR }), pos);
    expect(s.goal).toEqual(FAR);
    // A nearer, only-mildly-better pickup: score wins raw, loses the
    // switching cost - the committed line holds.
    g.pick(flat({ pickup: NEAR }), pos);
    expect(s.goal).toEqual(FAR);
  });

  it('a clearly better offer IS a good reason to turn', () => {
    const { s, g } = kit();
    botRng(() => 0.5);
    g.pick(flat({ pickup: FAR }), pos);
    // An objective offer outweights a pickup ~4x at the same spot -
    // the human "worth turning for" case.
    g.pick(flat({ pickup: NEAR, objective: NEAR }), pos);
    expect(s.goal).toEqual(NEAR);
  });

  it('under fire the loyalty drops - danger always interrupts', () => {
    const { s, g } = kit();
    botRng(() => 0.5);
    g.pick(flat({ pickup: FAR }), pos);
    // Same marginal detour as test 1, but with a threat live: the
    // switching cost shrinks and the bot reroutes.
    g.pick(flat({ pickup: NEAR, threats: [{ x: 1, y: 0, z: 1 }] }), pos);
    expect(s.goal).toEqual(NEAR);
  });

  it('a stale line earns no loyalty - wedged transit is droppable', () => {
    const { s, g } = kit();
    botRng(() => 0.5);
    g.pick(flat({ pickup: FAR }), pos);
    s.goalAge = 61; // >60 thinks ≈ >20s on the same line
    g.pick(flat({ pickup: NEAR }), pos);
    expect(s.goal).toEqual(NEAR);
  });
});
