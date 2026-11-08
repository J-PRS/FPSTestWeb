import { describe, expect, it } from 'bun:test';
import { scanVisible, newHuntState, pickHunt } from '../../shared/botHunt.ts';
import { dodge } from '../../shared/botEscape.ts';
import type { BrainCtx, BotEnemy } from '../../shared/botBrain.ts';
import type { BotVec } from '../../shared/botVec.ts';

const pos = { x: 0, y: 0, z: 0 };
const mkEnemy = (id: string, x: number, z: number, hpFrac?: number): BotEnemy => ({
  id, pos: { x, y: 0, z }, vel: { x: 0, y: 0, z: 0 }, alive: true, hpFrac,
});

const ctx = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos, enemies: [], now: 0, groundY: () => 0,
  losClear: () => true,
  ...over,
} as BrainCtx);

describe('attention cone — committed hunts tunnel', () => {
  const EAST = mkEnemy('east', 60, 0);       // on the focus bearing
  const BEHIND = mkEnemy('behind', -60, 0);  // opposite the bearing
  const FACE = mkEnemy('face', -10, 0);      // behind but inside 25m reflex
  const focus: BotVec = { x: 60, y: 0, z: 0 };

  it('off-cone enemy beyond reflex range is invisible', () => {
    const r = scanVisible(ctx({ enemies: [EAST, BEHIND] }), pos, 200, 0, undefined, focus);
    expect(r.player).toBe(EAST);
  });
  it('off-cone enemy inside 25m reflex IS noticed', () => {
    const r = scanVisible(ctx({ enemies: [EAST, FACE] }), pos, 200, 0, undefined, focus);
    const ids = [r.player?.id];
    // nearer one wins the pick - face is closer than east
    expect(ids).toContain('face');
  });
  it('no focus = full 360 sweep (unchanged)', () => {
    const r = scanVisible(ctx({ enemies: [BEHIND, EAST] }), pos, 200, 0);
    expect(r.player).toBe(BEHIND); // nearer
  });
});

describe('dodge horizon — anticipation by shell velocity', () => {
  const dest = { x: 0, y: 0, z: 100 };

  it('a closing shell at 40m reads as arriving - vel anticipates', () => {
    // shell 40m out moving 60 m/s at the bot: closing inside ~0.85s
    // horizon (skill=1) -> effective distance < DODGE_RANGE gate
    const t = { x: 0, y: 0, z: 40, vel: { x: 0, y: 0, z: -60 } } as unknown as BotVec;
    const out = dodge(ctx({ threats: [t] }), pos, dest, false, 1);
    expect(out).not.toEqual(dest);
  });
  it('same shell without velocity (position only) is not yet a threat', () => {
    const t = { x: 0, y: 0, z: 40 } as unknown as BotVec;
    const out = dodge(ctx({ threats: [t] }), pos, dest, false, 1);
    expect(out).toEqual(dest);
  });
  it('higher skill widens the horizon - better movers juke earlier', () => {
    const t = { x: 0, y: 0, z: 50, vel: { x: 0, y: 0, z: -60 } } as unknown as BotVec;
    expect(dodge(ctx({ threats: [t] }), pos, dest, false, 0.2)).toEqual(dest);   // scrub: horizon too short
    expect(dodge(ctx({ threats: [t] }), pos, dest, false, 1.6)).not.toEqual(dest); // tracker: reads the launch
  });
});

describe('finisher bias — wounded outranks near', () => {
  const st = newHuntState(pos, 'medium');
  const WOUNDED = mkEnemy('wounded', 80, 0, 0.3);
  const HEALTHY = mkEnemy('healthy', 50, 10, 1);

  it('a sub-60% hp contact outranks a nearer healthy one', () => {
    pickHunt(st, ctx({ enemies: [HEALTHY, WOUNDED] }), pos, 0,
      { hero: false, fearing: false }, () => {});
    expect(st.hunt?.id).toBe('wounded');
  });
});
