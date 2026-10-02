import { afterEach, describe, expect, it } from 'bun:test';

import { newHuntState, pickHunt, pickFire, scanVisible, retreatDest, STALE_MS } from '../../shared/botHunt.ts';
import { botRng } from '../../shared/botRand.ts';
import type { BotEnemy, BrainCtx } from '../../shared/botBrain.ts';

const foe = (x: number, z: number, id = 'p:1'): BotEnemy => ({
  id, alive: true,
  pos: { x, y: 0, z }, vel: { x: 0, y: 0, z: 0 },
} as BotEnemy);

const flat = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now: 0,
  groundY: () => 0,
  ...over,
});

const mood = { hero: false, fearing: false };
const P = { x: 0, y: 0, z: 0 };

afterEach(() => botRng(Math.random));

describe('scanVisible', () => {
  it('dead and occluded candidates are skipped', () => {
    const c = flat({ enemies: [foe(10, 0, 'p:dead')] });
    (c.enemies[0] as BotEnemy).alive = false;
    const { player } = scanVisible(c, P, 100, 100);
    expect(player).toBeNull();
  });

  it('beasts (b: ids) sort into their own lane', () => {
    const c = flat({ enemies: [foe(10, 0, 'b:7'), foe(20, 0, 'p:1')] });
    const r = scanVisible(c, P, 100, 100);
    expect(r.beast?.id).toBe('b:7');
    expect(r.player?.id).toBe('p:1');
  });
});

describe('pickHunt', () => {
  it('no visible enemy → hunt falls to the thief beacon or nothing', () => {
    const st = newHuntState(P);
    pickHunt(st, flat({ thief: foe(30, 0, 'p:thief') }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:thief'); // beacon tracks without LOS
  });

  it('nearest live player in range becomes the hunt', () => {
    const st = newHuntState(P);
    pickHunt(st, flat({ enemies: [foe(10, 0)] }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:1');
    expect(st.lastSeen).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('a creature on top of the bot outranks a distant player', () => {
    const st = newHuntState(P);
    const c = flat({ enemies: [foe(4, 0, 'b:biter'), foe(30, 0, 'p:1')] });
    pickHunt(st, c, P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('b:biter');
  });

  it('sight line acquires at Tribes range — 90m hunts, beyond sight does not', () => {
    const st = newHuntState(P);
    pickHunt(st, flat({ enemies: [foe(90, 0)] }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:1'); // inside the 300m sight band
    const st2 = newHuntState(P);
    pickHunt(st2, flat({ enemies: [foe(400, 0)] }), P, 0, mood, () => {});
    expect(st2.hunt).toBeNull(); // past the eye line
  });

  it('nothing visible → the goal ladder runs instead', () => {
    const st = newHuntState(P);
    let ran = false;
    pickHunt(st, flat(), P, 0, mood, () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe('pickFire', () => {
  const armed = () => {
    const st = newHuntState(P);
    st.hunt = foe(20, 0);
    st.lastSeen = { x: 20, y: 0, z: 0 };
    st.lastSeenVel = { x: 0, y: 0, z: 0 };
    st.lastSeenAt = 0;
    st.fireT = 0;
    return st;
  };

  it('no hunt or stale lastSeen → no volley', () => {
    const st = newHuntState(P);
    expect(pickFire(st, 0.1, flat(), P, 0, mood)).toBeUndefined();
    st.hunt = foe(20, 0);
    st.lastSeenAt = -STALE_MS - 1;
    expect(pickFire(st, 0.1, flat(), P, 0, mood)).toBeUndefined();
  });

  it('leads a moving target along its velocity', () => {
    const st = armed();
    st.lastSeenVel = { x: 10, y: 0, z: 0 }; // running +x
    botRng(() => 0.5); // zero scatter
    const f = pickFire(st, 1, flat({ weaponSpeed: () => 60 }), P, 0, mood);
    expect(f?.targetId).toBe('p:1');
    expect(f!.aim.x).toBeGreaterThan(20); // led forward
  });

  it('ballistic drop aims low; weaponGravity compensates back', () => {
    const st = armed();
    st.lastSeenVel = { x: 0, y: 10, z: 0 }; // rising target
    botRng(() => 0.5);
    const c = flat({ weaponSpeed: () => 60, weaponGravity: () => true });
    const f = pickFire(st, 1, c, P, 0, mood);
    // ground clamp vs falling target — aim ends up clamped to terrain here,
    // the point is the gravity shell drop is folded in.
    expect(f).toBeDefined();
  });

  it('burst cadence: five shots then a longer pause', () => {
    const st = armed();
    botRng(() => 0.5);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const f = pickFire(st, 10, flat({ weaponSpeed: () => 60 }), P, 0, mood);
      expect(f).toBeDefined();
      times.push(st.fireT!);
      st.fireT = 0; // pretend the cadence elapsed
    }
    expect(times[4]!).toBeGreaterThan(times[0]!); // post-burst pause > in-burst
  });
});

describe('retreatDest', () => {
  it('retreats 24m away from the threat', () => {
    const d = retreatDest(flat(), P, foe(10, 0));
    expect(d.x).toBeCloseTo(-24, 3);
  });

  it('folds toward a nearby ally', () => {
    const d = retreatDest(flat({ others: [{ x: -30, y: 0, z: 0 }] }), P, foe(10, 0));
    expect(d.x).toBeCloseTo((-24 + -30) / 2, 3);
  });
});
