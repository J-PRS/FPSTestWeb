import { describe, it, expect, afterEach } from 'bun:test';
import { BotBrain, type BrainCtx, type BotEnemy, type BrainOut } from '../../shared/botBrain.ts';
import { botRng, botRngRelease } from '../../shared/botRand.ts';
import { losMemoReset } from '../../shared/botLos.ts';

// BotBrain.think — the decision head above the senses. The senses are
// pinned in their own files; this pins what the HEAD does with them:
// chatter edges fire once and in priority order, the belt window and
// cooldown, the hurt/hero mood roll, objective outranking pickups, and
// twin-instance determinism (same seed, same steps → same decisions).

const FLAT = () => 0;
const origin = { x: 0, y: 0, z: 0 };
const foe = (over: Partial<BotEnemy> = {}): BotEnemy => ({
  id: 'e1', pos: { x: 25, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, alive: true, ...over,
});
const ctx = (over: Partial<BrainCtx> = {}): BrainCtx =>
  ({ pos: origin, vel: { x: 1, y: 0, z: 0 }, enemies: [], now: 0, groundY: FLAT, ...over } as BrainCtx);

/** Drive thinks until `fn` yields a value or the step budget runs out —
 *  acquisition has a human-scale reaction delay, so single-think asserts
 *  would flake on the acquiredAt lag, not the behavior. */
const untilOut = (b: BotBrain, c: BrainCtx, fn: (o: BrainOut) => boolean, steps = 40): BrainOut => {
  let out: BrainOut = b.think(0.35, c);
  for (let i = 0; i < steps && !fn(out); i++) { c.now += 350; out = b.think(0.35, c); }
  return out;
};

afterEach(() => { botRngRelease(); losMemoReset(); });

describe('botBrain', () => {
  it('acquiring a live enemy says contact once — not on every think', () => {
    botRng(() => 0.9);
    const b = new BotBrain(origin);
    const c = ctx({ enemies: [foe()] });
    const hit = untilOut(b, c, (o) => o.say?.kind === 'contact');
    expect(hit.say?.kind).toBe('contact');
    // Same enemy still visible — the edge already fired, no repeat.
    for (let i = 0; i < 6; i++) { c.now += 350; const o = b.think(0.35, c); expect(o.say?.kind).not.toBe('contact'); }
  });

  it('dropping the hunt says lost once', () => {
    botRng(() => 0.9);
    const b = new BotBrain(origin);
    const c = ctx({ enemies: [foe()] });
    untilOut(b, c, (o) => o.say?.kind === 'contact');
    c.enemies = [];
    const lost = untilOut(b, c, (o) => o.say?.kind === 'lost', 60);
    expect(lost.say?.kind).toBe('lost');
    for (let i = 0; i < 6; i++) { c.now += 350; const o = b.think(0.35, c); expect(o.say?.kind).not.toBe('lost'); }
  });

  it('a wound under fearHp says fear when the hero roll fails — once per episode', () => {
    botRng(() => 0.9); // 0.9 > heroChance → no hero
    const b = new BotBrain(origin);
    const c = ctx({ healthFrac: 0.1 });
    const o = b.think(0.35, c);
    expect(o.say?.kind).toBe('fear');
    c.now += 350;
    expect(b.think(0.35, c).say?.kind).not.toBe('fear');
  });

  it('a heavy hoard raises the fear threshold — carriers bail earlier', () => {
    botRng(() => 0.9);
    const b = new BotBrain(origin);
    // 0.30 health is far above the 0.15 base floor — an empty pocket
    // keeps fighting, a 40-token carrier is already breaking contact.
    const empty = ctx({ healthFrac: 0.3 });
    expect(b.think(0.35, empty).say?.kind).not.toBe('fear');
    const hoarder = ctx({ healthFrac: 0.3, held: 40 });
    expect(b.think(0.35, hoarder).say?.kind).toBe('fear');
  });

  it('a successful hero roll says hero and suppresses fear', () => {
    botRng(() => 0.2); // 0.2 < heroChance → hero
    const b = new BotBrain(origin);
    const c = ctx({ healthFrac: 0.1 });
    const o = b.think(0.35, c);
    expect(o.say?.kind).toBe('hero');
  });

  it('healing re-arms the wound edge — the next episode speaks again', () => {
    botRng(() => 0.9);
    const b = new BotBrain(origin);
    const c = ctx({ healthFrac: 0.1 });
    expect(b.think(0.35, c).say?.kind).toBe('fear');
    c.healthFrac = 1; c.now += 350; b.think(0.35, c);
    c.healthFrac = 0.1; c.now += 350;
    expect(b.think(0.35, c).say?.kind).toBe('fear');
  });

  it('inbound shells say underfire once — the latch holds while threatened', () => {
    botRng(() => 0.9);
    const b = new BotBrain(origin);
    const c = ctx({ threats: [{ x: 10, y: 1, z: 0 }] });
    const o = untilOut(b, c, (o2) => o2.say?.kind === 'underfire');
    expect(o.say?.kind).toBe('underfire');
    c.now += 350;
    expect(b.think(0.35, c).say?.kind).not.toBe('underfire');
  });

  it('a genuinely empty field says bored once after 40s of silence', () => {
    botRng(() => 0.9);
    const b = new BotBrain(origin);
    const c = ctx();
    c.now = 41_000; // lastSeenAt defaults to 0 — long-quiet
    const o = untilOut(b, c, (o2) => o2.say?.kind === 'bored');
    expect(o.say?.kind).toBe('bored');
    c.now += 350;
    expect(b.think(0.35, c).say?.kind).not.toBe('bored');
  });

  it('a fresh mid-range hunt lobs the belt once, then cools down', () => {
    botRng(() => 0.9);
    const b = new BotBrain(origin);
    const c = ctx({ enemies: [foe({ pos: { x: 20, y: 0, z: 0 } })] });
    // Belt needs a live hunt with a fresh lastSeen — drive until armed.
    untilOut(b, c, () => b.currentHuntId === 'e1');
    expect(b.currentHuntId).toBe('e1');
    const lob = untilOut(b, c, (o) => o.belt === true, 30);
    expect(lob.belt).toBe(true);
    c.now += 350;
    expect(b.think(0.35, c).belt).toBeFalsy();
  });

  it('the belt never lobs at knife range or past its arc', () => {
    botRng(() => 0.9);
    const close = new BotBrain(origin);
    // Belt window is 5-45m since 7b68f96cd - knife range is sub-5m now.
    const c = ctx({ enemies: [foe({ pos: { x: 4, y: 0, z: 0 } })] });
    const o1 = untilOut(close, c, (o) => o.belt === true, 30);
    expect(o1.belt ?? false).toBeFalsy();
    const far = new BotBrain(origin);
    const c2 = ctx({ enemies: [foe({ pos: { x: 60, y: 0, z: 0 } })] });
    const o2 = untilOut(far, c2, (o) => o.belt === true, 30);
    expect(o2.belt ?? false).toBeFalsy();
  });

  it('a committed runner holds the objective; an uncommitted bot takes the nearer pickup', () => {
    botRng(() => 0.9);
    // Utility scoring: objective weight 3.5 when committed (runner/wave/
    // posted) vs 1.0 idle — so the far flag beats a close gem only for
    // the bot whose job is the route.
    const runner = new BotBrain(origin);
    const cr = ctx({ runner: true, objective: { x: 120, y: 0, z: 0 }, pickup: { x: -50, y: 0, z: 0 } });
    for (let i = 0; i < 40; i++) { cr.now += 350; runner.think(0.35, cr); }
    // The step dest arcs with the ski-line planner (roundabout cap routes
    // by design) — the commitment lives in the picked goal itself.
    expect(runner.goalS.goal.x).toBeCloseTo(120, 0);
    // Coin-greed is a spawn-hash trait: origin hashes to ~0 (dead to
    // piles), (-30,0,0) hashes ~0.96 - the idle leg needs a greedy spawn
    // or the lone coin can't outbid the weight-1 objective (ba5f9f95
    // pile pricing: lone coin ~0.55x, personality-scaled).
    const idle = new BotBrain({ x: -30, y: 0, z: 0 });
    const ci = ctx({ objective: { x: 120, y: 0, z: 0 }, pickup: { x: -50, y: 0, z: 0 } });
    for (let i = 0; i < 40; i++) { ci.now += 350; idle.think(0.35, ci); }
    expect(idle.goalS.goal.x).toBeCloseTo(-50, 0);
  });

  it('twin brains on the same seed replay identical decisions', () => {
    botRng(() => 0.9);
    const a = new BotBrain(origin);
    const b2 = new BotBrain(origin);
    const enemies = [foe(), foe({ id: 'e2', pos: { x: -30, y: 0, z: 40 } })];
    const c = ctx({ enemies, pickup: { x: 10, y: 0, z: -10 } });
    for (let i = 0; i < 50; i++) {
      c.now += 350;
      const oa = a.think(0.35, c);
      const ob = b2.think(0.35, c);
      expect(ob.dest).toEqual(oa.dest);
      expect(ob.say).toEqual(oa.say);
      expect(ob.fire?.targetId).toBe(oa.fire?.targetId);
      expect(ob.belt).toBe(oa.belt);
    }
  });
});
